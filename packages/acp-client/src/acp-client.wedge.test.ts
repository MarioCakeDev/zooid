import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { AcpClient } from './acp-client.js'
import { AcpSessionWedgeError, isSessionWedge, classify } from './errors.js'

/**
 * Regression tests for the 2026-09-30 "agents are deaf" class of failure.
 *
 * The signature: the daemon resumes a session id across a restart, the
 * container accepts the prompt as a `user_message_chunk`, and then nothing
 * ever comes back — no chunk, no tool call, no error, no CPU. The prompt
 * never fails, so every layer above believes the turn is running.
 *
 * The fix is a *first-response deadline*: the prompt is only considered
 * started once the agent emits literally anything. These tests pin both the
 * detection and — just as important — the absence of false positives.
 */

class SilentChild extends EventEmitter {
  stdout = new Readable({ read() {} })
  stdin = new Writable({ write(_c, _e, cb) { cb() } })
  stderr = new Readable({ read() {} })
  pid = 1
  kill = vi.fn(() => true)
}

interface HarnessOpts {
  firstResponseMs?: number
  loadSessionCapable?: boolean
  persistedSessionId?: string
}

function makeClient(opts: HarnessOpts = {}) {
  const child = new SilentChild()
  const rt = { spawn: vi.fn().mockReturnValue(child as unknown as ChildProcess) }
  const store = {
    get: vi.fn(() => opts.persistedSessionId),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    load: vi.fn(async () => {}),
  }
  const client = new AcpClient({
    agent: { id: 'dev', command: 'opencode', args: ['acp'] },
    onEvent: () => {},
    onApprovalRequest: async () => ({ decision: 'cancel' }),
    runtime: rt,
    timeouts: { firstResponseMs: opts.firstResponseMs ?? 40 },
  })
  const internals = client as unknown as {
    connection: unknown
    initialized: boolean
    agentCapabilities: { loadSession?: boolean }
    store: unknown
    storeLoaded: Promise<void>
    buildClient: () => {
      sessionUpdate: (p: unknown) => Promise<void>
      requestPermission: (p: unknown) => Promise<unknown>
    }
  }
  internals.connection = {}
  internals.initialized = true
  internals.agentCapabilities = opts.loadSessionCapable ? { loadSession: true } : {}
  internals.store = store
  internals.storeLoaded = Promise.resolve()
  return { client, child, store, internals }
}

/** Swap in a fake ACP connection, as a completed handshake would. */
function stubConnection(client: AcpClient, connection: Record<string, unknown>): void {
  ;(client as unknown as { connection: unknown }).connection = connection
}

/** Push an inbound ACP notification, as a live shim would. */
function emitSessionUpdate(internals: ReturnType<typeof makeClient>['internals'], sessionId: string) {
  return internals.buildClient().sessionUpdate({
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
  })
}

function promptOnce(client: AcpClient) {
  return client.prompt({ threadId: 'thread-1', content: [{ type: 'text', text: 'continue' }] })
}

describe('AcpClient first-response deadline', () => {
  it('rejects with a wedge error when a session never answers a prompt', async () => {
    const { client } = makeClient({ firstResponseMs: 40 })
    // newSession resolves; the prompt response never does.
    stubConnection(client, {
      newSession: vi.fn(async () => ({ sessionId: 'ses-wedged' })),
      prompt: vi.fn(() => new Promise(() => {})),
    })
    const err = await promptOnce(client).catch((e) => e)
    expect(isSessionWedge(err)).toBe(true)
    expect(err).toBeInstanceOf(AcpSessionWedgeError)
    expect(err.message).toMatch(/produced no output within 40ms/)
    expect(err.sessionId).toBe('ses-wedged')
  })

  it('does NOT flag a session that answers slowly but does answer', async () => {
    const { client, internals } = makeClient({ firstResponseMs: 500 })
    let resolvePrompt!: (v: { stopReason: string }) => void
    stubConnection(client, {
      newSession: vi.fn(async () => ({ sessionId: 'ses-slow' })),
      prompt: vi.fn(() => new Promise((r) => { resolvePrompt = r })),
    })
    const pending = promptOnce(client)
    // First chunk lands 40ms in — well inside the deadline, but nowhere near
    // instant. A wedge and a slow agent look the same until something arrives.
    setTimeout(() => void emitSessionUpdate(internals, 'ses-slow'), 40)
    setTimeout(() => resolvePrompt({ stopReason: 'end_turn' }), 120)
    await expect(pending).resolves.toEqual({ stopReason: 'end_turn', sessionId: 'ses-slow' })
    expect(client.isAlive()).toBe(true)
  })

  it('disarms the deadline as soon as anything arrives, even if the prompt response never comes', async () => {
    const { client, internals } = makeClient({ firstResponseMs: 60 })
    stubConnection(client, {
      newSession: vi.fn(async () => ({ sessionId: 'ses-chatty' })),
      prompt: vi.fn(() => new Promise(() => {})),
    })
    void promptOnce(client).catch(() => {})
    await new Promise((r) => setTimeout(r, 5))
    // A tool call is output too: the agent is alive and working.
    await emitSessionUpdate(internals, 'ses-chatty')
    await new Promise((r) => setTimeout(r, 150))
    expect(client.isAlive()).toBe(true)
  })

  it('treats a permission request as a response (arms no false wedge)', async () => {
    const { client, internals } = makeClient({ firstResponseMs: 60 })
    stubConnection(client, {
      newSession: vi.fn(async () => ({ sessionId: 'ses-ask' })),
      prompt: vi.fn(() => new Promise(() => {})),
    })
    void promptOnce(client).catch(() => {})
    await new Promise((r) => setTimeout(r, 5))
    void internals.buildClient().requestPermission({
      sessionId: 'ses-ask',
      toolCall: { toolCallId: 't1', title: 'edit' },
      options: [],
    })
    await new Promise((r) => setTimeout(r, 150))
    expect(client.isAlive()).toBe(true)
  })

  it('is NOT disarmed by ambient session metadata alone', async () => {
    // A shim on a wedged session can still emit `available_commands_update`
    // after the prompt. That is session metadata, not turn output, so it must
    // not buy a dead session a pass.
    const { client, internals } = makeClient({ firstResponseMs: 60 })
    stubConnection(client, {
      newSession: vi.fn(async () => ({ sessionId: 'ses-metadata' })),
      prompt: vi.fn(() => new Promise(() => {})),
    })
    void promptOnce(client).catch(() => {})
    await new Promise((r) => setTimeout(r, 5))
    await internals.buildClient().sessionUpdate({
      sessionId: 'ses-metadata',
      update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
    })
    const err = await promptOnce(client).catch((e: unknown) => e).catch(() => null)
    void err
    await new Promise((r) => setTimeout(r, 120))
    expect(client.isAlive()).toBe(false)
  })

  it('invalidates the wedged session in memory AND in the persisted store', async () => {
    const { client, store } = makeClient({
      firstResponseMs: 40,
      loadSessionCapable: true,
      persistedSessionId: 'resumed-from-last-run',
    })
    stubConnection(client, {
      // Resumed successfully — the handshake looks perfect, like the real bug.
      loadSession: vi.fn(async () => null),
      newSession: vi.fn(async () => ({ sessionId: 'fresh-session' })),
      prompt: vi.fn(() => new Promise(() => {})),
    })
    await promptOnce(client).catch(() => {})
    expect(store.delete).toHaveBeenCalledWith('thread-1')
    expect(client.isAlive()).toBe(false)
    // The session is gone from the in-memory map too, so nothing in this
    // process can resume 'resumed-from-last-run' — the corpse we refuse to
    // walk back into.
    const sessions = (client as unknown as { sessions: { get: (k: unknown) => unknown } }).sessions
    expect(sessions.get({ threadId: 'thread-1', agentId: 'dev' })).toBeUndefined()
  })

  it('reports the client dead so the registry reconnects instead of reusing it', async () => {
    const { client } = makeClient({ firstResponseMs: 40 })
    stubConnection(client, {
      newSession: vi.fn(async () => ({ sessionId: 'ses-dead' })),
      prompt: vi.fn(() => new Promise(() => {})),
    })
    await promptOnce(client).catch(() => {})
    expect(client.isAlive()).toBe(false)
    // …and the rejection reason survives for the registry to classify.
    await expect(promptOnce(client)).rejects.toThrow(/wedged session/)
  })

  it('classifies a wedge as a transient session_wedge, not a generic internal error', async () => {
    const err = new AcpSessionWedgeError('wedged', { sessionId: 's', timeoutMs: 10 })
    expect(classify(err)).toEqual({ code: 'session_wedge', transient: true })
  })

  it('never fires when the deadline is disabled (0)', async () => {
    const { client } = makeClient({ firstResponseMs: 0 })
    stubConnection(client, {
      newSession: vi.fn(async () => ({ sessionId: 'ses-unbounded' })),
      prompt: vi.fn(() => new Promise(() => {})),
    })
    const pending = promptOnce(client)
    const raced = await Promise.race([pending, new Promise((r) => setTimeout(() => r('still-pending'), 120))])
    expect(raced).toBe('still-pending')
  })

  it('does not leave the timer armed after a normal turn', async () => {
    const { client, internals } = makeClient({ firstResponseMs: 30 })
    stubConnection(client, {
      newSession: vi.fn(async () => ({ sessionId: 'ses-ok' })),
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
    })
    await promptOnce(client)
    await new Promise((r) => setTimeout(r, 80))
    // A stale timer here would mark a healthy client dead mid-next-turn.
    expect(client.isAlive()).toBe(true)
    expect(internals).toBeDefined()
  })
})