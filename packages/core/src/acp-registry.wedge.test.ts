import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import type { AcpRuntime, AcpSpawnSpec } from './acp-types.js'
import type { AgentEvent } from '@zooid/acp-client'

/**
 * The 2026-09-30 defect, at the registry layer: a resumed session accepts a
 * prompt and never answers. Detection lives in `AcpClient`; what is tested
 * here is the part only the registry can do — reconnect, re-establish a fresh
 * session, replay the owner's prompt so they never retype "continue", tell
 * them it happened, and stop after a bounded number of attempts.
 *
 * The unbounded version of this loop is the earlier `[container_exit] ACP
 * connection closed` batch-close incident, so the bound is a hard requirement,
 * not a nicety.
 */

class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} })
  stdin = new Writable({ write(_c: unknown, _e: unknown, cb: () => void) { cb() } })
  stderr = new Readable({ read() {} })
  pid = 1
  kill = vi.fn(() => true)
}

class StubRuntime implements AcpRuntime {
  spawn = vi.fn((_: AcpSpawnSpec) => new FakeChild() as unknown as ReturnType<AcpRuntime['spawn']>)
}

interface FakeClient {
  start: ReturnType<typeof vi.fn>
  ensureSession: ReturnType<typeof vi.fn>
  prompt: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  isAlive: ReturnType<typeof vi.fn>
}

const AcpClientMock = vi.fn()

vi.mock('@zooid/acp-client', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return { ...real, AcpClient: AcpClientMock }
})

const { AcpAgentRegistry } = await import('./acp-registry.js')
const { AcpSessionWedgeError } = (await import('@zooid/acp-client')) as unknown as {
  AcpSessionWedgeError: new (
    message: string,
    opts: { sessionId?: string | null; timeoutMs: number },
  ) => Error
}

const AGENTS = {
  dev: {
    name: 'dev',
    workdir: '.',
    hooks: {},
    acp: { command: 'opencode', args: ['acp'] },
    approval_timeout_ms: 0,
  },
}

function wedge(sessionId: string | null): InstanceType<typeof AcpSessionWedgeError> {
  return new AcpSessionWedgeError(
    `AcpClient(dev): session ${sessionId} produced no output within 40ms of a prompt; ` +
      `treating it as a wedged session`,
    { sessionId, timeoutMs: 40 },
  )
}

function newClient(over: Partial<FakeClient> = {}): FakeClient {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    ensureSession: vi.fn().mockResolvedValue('session-fresh'),
    prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn', sessionId: 'session-fresh' }),
    stop: vi.fn().mockResolvedValue(undefined),
    isAlive: vi.fn(() => true),
    ...over,
  }
}

/**
 * A client that accepts a prompt and then goes deaf — the real failure. The
 * real `AcpClient` also marks itself dead when it detects the wedge, which is
 * what makes the registry drop the handle instead of reusing it, so the double
 * does the same.
 */
function deafClient(sessionId: string): FakeClient {
  const alive = { value: true }
  return newClient({
    prompt: vi.fn().mockImplementation(async () => {
      alive.value = false
      throw wedge(sessionId)
    }),
    isAlive: vi.fn(() => alive.value),
  })
}

describe('AcpAgentRegistry — wedged session recovery', () => {
  let events: Array<{ name: string; event: AgentEvent }>
  let rekeys: Array<[string, string, string]>
  let runtime: StubRuntime

  function build(opts: { maxPromptAttempts?: number } = {}) {
    events = []
    rekeys = []
    runtime = new StubRuntime()
    const registry = new AcpAgentRegistry({
      runtime,
      agents: AGENTS as never,
      onEvent: (name, event) => events.push({ name, event }),
      maxPromptAttempts: opts.maxPromptAttempts,
      onSessionRekey: (name, _threadId, prev, next) => rekeys.push([name, prev, next]),
    })
    return registry
  }

  beforeEach(() => {
    AcpClientMock.mockReset()
  })

  it('passes a healthy prompt straight through — no recovery, no notice', async () => {
    const client = newClient()
    AcpClientMock.mockImplementation(() => client)
    const registry = build()
    const input = { threadId: 'thread-1', content: [{ type: 'text' as const, text: 'continue' }] }
    await expect(registry.prompt('dev', input)).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(client.prompt).toHaveBeenCalledTimes(1)
    expect(events).toHaveLength(0)
    expect(rekeys).toHaveLength(0)
  })

  it('reconnects on a fresh session and replays the prompt when the first session wedges', async () => {
    // First container resumes a session from the previous run and goes deaf;
    // the replacement container answers normally.
    const wedged = deafClient('session-resumed')
    const healthy = newClient()
    AcpClientMock.mockImplementationOnce(() => wedged).mockImplementationOnce(() => healthy)
    const registry = build()
    const input = { threadId: 'thread-1', content: [{ type: 'text' as const, text: 'continue' }] }

    const result = await registry.prompt('dev', input)

    // The owner's message was replayed verbatim — they never retype "continue".
    expect(wedged.prompt).toHaveBeenCalledTimes(1)
    expect(healthy.prompt).toHaveBeenCalledTimes(1)
    expect(healthy.prompt.mock.calls[0]![0]).toEqual(input)
    // A fresh session, and the dead client was told to stop.
    expect(healthy.ensureSession).toHaveBeenCalledWith('thread-1', undefined, undefined)
    expect(wedged.stop).toHaveBeenCalled()
    // …and the turn reports the session it actually ran on, so transports can
    // re-key their per-session state.
    expect(result.sessionId).toBe('session-fresh')
    expect(rekeys).toEqual([['dev', 'session-resumed', 'session-fresh']])
  })

  it('surfaces a visible notice when it recovers, naming the replay', async () => {
    AcpClientMock.mockImplementationOnce(() => deafClient('s1')).mockImplementationOnce(() => newClient())
    const registry = build()
    await registry.prompt('dev', { threadId: 't', content: [] })
    expect(events).toHaveLength(1)
    expect(events[0]!.event).toMatchObject({
      type: 'session_wedge',
      sessionId: 's1',
      recovered: true,
      attempt: 1,
      maxAttempts: 2,
      recoveredSessionId: 'session-fresh',
    })
  })

  it('bounds the replay: one retry, then it gives up instead of looping', async () => {
    const first = deafClient('s1')
    const second = deafClient('s2')
    const third = newClient()
    AcpClientMock
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second)
      .mockImplementation(() => third)
    const registry = build()
    const err = await registry
      .prompt('dev', { threadId: 't', content: [] })
      .catch((e) => e)
    expect(first.prompt).toHaveBeenCalledTimes(1)
    expect(second.prompt).toHaveBeenCalledTimes(1)
    // A third client was never asked to do anything.
    expect(third.prompt).not.toHaveBeenCalled()
    expect(err).toBeInstanceOf(AcpSessionWedgeError)
    // The last attempt reports failure, not a fake recovery.
    const last = events[events.length - 1]!.event
    expect(last).toMatchObject({ type: 'session_wedge', recovered: false, attempt: 2, maxAttempts: 2 })
  })

  it('honours maxPromptAttempts: 1 — recovery disabled', async () => {
    const client = deafClient('s1')
    AcpClientMock.mockImplementation(() => client)
    const registry = build({ maxPromptAttempts: 1 })
    await expect(registry.prompt('dev', { threadId: 't', content: [] })).rejects.toThrow(/wedged/)
    expect(client.prompt).toHaveBeenCalledTimes(1)
    expect(rekeys).toHaveLength(0)
  })

  it('does not recover from a non-wedge failure (a real error is not a dead session)', async () => {
    const client = newClient({ prompt: vi.fn().mockRejectedValue(new Error('model unavailable')) })
    AcpClientMock.mockImplementation(() => client)
    const registry = build()
    await expect(registry.prompt('dev', { threadId: 't', content: [] })).rejects.toThrow(/model unavailable/)
    expect(client.prompt).toHaveBeenCalledTimes(1)
    expect(events).toHaveLength(0)
  })

  it('rejects a nonsense replay budget instead of failing with bare undefined', async () => {
    // Math.max(1, NaN) is NaN: the attempt loop would never run and prompt()
    // would reject with `undefined` — a silent-with-no-cause failure, which is
    // the exact class this layer exists to prevent.
    AcpClientMock.mockImplementation(() => newClient())
    const registry = build({ maxPromptAttempts: Number.NaN })
    await expect(registry.prompt('dev', { threadId: 't', content: [] })).rejects.toThrow(
      /maxPromptAttempts: must be an integer >= 1/,
    )
    expect(AcpClientMock).not.toHaveBeenCalled()
  })

  it('forwards the per-agent first_response_timeout_ms override to the client', async () => {
    AcpClientMock.mockImplementation(() => newClient())
    const registry = new AcpAgentRegistry({
      runtime,
      agents: {
        dev: { ...AGENTS.dev, first_response_timeout_ms: 45_000 } as never,
      },
      timeouts: { initializeMs: 10_000 },
    })
    await registry.prompt('dev', { threadId: 't', content: [] })
    expect(AcpClientMock.mock.calls[0]![0]).toMatchObject({
      timeouts: { initializeMs: 10_000, firstResponseMs: 45_000 },
    })
  })

  it('falls back to the registry-wide first-response deadline when the agent sets none', async () => {
    AcpClientMock.mockImplementation(() => newClient())
    const registry = new AcpAgentRegistry({
      runtime,
      agents: AGENTS as never,
      timeouts: { firstResponseMs: 7_000 },
    })
    await registry.prompt('dev', { threadId: 't', content: [] })
    expect(AcpClientMock.mock.calls[0]![0]).toMatchObject({
      timeouts: { firstResponseMs: 7_000 },
    })
  })
})