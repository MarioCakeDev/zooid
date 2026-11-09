import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import type { AcpRuntime, AcpSpawnSpec } from './acp-types.js'

class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} })
  stdin = new Writable({ write(_c, _e, cb) { cb() } })
  stderr = new Readable({ read() {} })
  pid = 1
  kill = vi.fn(() => true)
}

class StubRuntime implements AcpRuntime {
  spawn = vi.fn((_: AcpSpawnSpec) => new FakeChild() as unknown as ReturnType<AcpRuntime['spawn']>)
}

vi.mock('@zooid/acp-client', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    AcpClient: vi.fn().mockImplementation(() => ({
      start: vi.fn().mockResolvedValue(undefined),
      ensureSession: vi.fn().mockResolvedValue('acp-session-1'),
      endSession: vi.fn().mockResolvedValue(undefined),
      closeIdleSession: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
      cancel: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      isAlive: vi.fn(() => true),
      ownsSession: vi.fn(() => true),
      isBusy: vi.fn(() => false),
      hasLiveSessions: vi.fn(() => false),
      canResumeSessions: vi.fn(() => true),
    })),
  }
})

const { AcpAgentRegistry } = await import('./acp-registry.js')

describe('AcpAgentRegistry', () => {
  let runtime: StubRuntime
  let registry: InstanceType<typeof AcpAgentRegistry>

  beforeEach(async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    AcpClient.mockClear()
    runtime = new StubRuntime()
    registry = new AcpAgentRegistry({
      runtime,
      agents: {
        triage: {
          name: 'triage',
          workdir: '.',
          hooks: {},
          acp: { preset: 'claude', mode: 'bypassPermissions' },
          approval_timeout_ms: 0,
        session_idle_timeout_ms: 600_000,
        },
        builder: {
          name: 'builder',
          workdir: '.',
          hooks: {},
          acp: { command: 'opencode', args: ['acp'] },
          approval_timeout_ms: 0,
        session_idle_timeout_ms: 600_000,
        },
      },
      env: { triage: { ANTHROPIC_API_KEY: 'sk-test' } },
    })
  })

  it('throws on prompt() for an unknown agent', async () => {
    await expect(
      registry.prompt('nope', { threadId: 't', content: [] }),
    ).rejects.toThrow(/unknown agent/i)
  })

  it('hasAgent reflects config keys', () => {
    expect(registry.hasAgent('triage')).toBe(true)
    expect(registry.hasAgent('nope')).toBe(false)
  })

  it('lazily starts a client on first prompt', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    expect(AcpClient).not.toHaveBeenCalled()
    await registry.prompt('triage', { threadId: 't1', content: [] })
    expect(AcpClient).toHaveBeenCalledTimes(1)
  })

  it('reuses the same client for one conversation, and gives each conversation its own process', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    await registry.prompt('triage', { threadId: 't1', content: [] })
    await registry.prompt('triage', { threadId: 't1', content: [] })
    expect(AcpClient).toHaveBeenCalledTimes(1)
    await registry.prompt('triage', { threadId: 't2', content: [] })
    expect(AcpClient).toHaveBeenCalledTimes(2)
    // The process identity is the conversation, not the agent: container
    // runtimes derive a unique container name from it.
    expect(AcpClient.mock.calls[0]![0].instanceId).toMatch(/^triage\u0000t1$/)
    expect(AcpClient.mock.calls[1]![0].instanceId).toMatch(/^triage\u0000t2$/)
  })

  it('keeps clients per-agent isolated', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    await registry.prompt('triage', { threadId: 't', content: [] })
    await registry.prompt('builder', { threadId: 't', content: [] })
    expect(AcpClient).toHaveBeenCalledTimes(2)
  })

  it('passes preset → AcpClient via @zooid/acp-client preset registry', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    await registry.prompt('triage', { threadId: 't', content: [] })
    const opts = AcpClient.mock.calls[0][0]
    expect(opts.agent.command).toBe('npx')
    expect(opts.agent.args).toEqual(['-y', '@agentclientprotocol/claude-agent-acp'])
  })

  it('passes explicit command/args through', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    await registry.prompt('builder', { threadId: 't', content: [] })
    const opts = AcpClient.mock.calls[0][0]
    expect(opts.agent.command).toBe('opencode')
    expect(opts.agent.args).toEqual(['acp'])
  })

  it('passes acp.mode into AcpClient.agent.mode, and leaves it unset otherwise', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    await registry.prompt('triage', { threadId: 't', content: [] })
    await registry.prompt('builder', { threadId: 't', content: [] })
    expect(AcpClient.mock.calls[0][0].agent.mode).toBe('bypassPermissions')
    expect(AcpClient.mock.calls[1][0].agent.mode).toBeUndefined()
  })

  it('passes per-agent env into AcpClient.agent.env', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    await registry.prompt('triage', { threadId: 't', content: [] })
    const opts = AcpClient.mock.calls[0][0]
    expect(opts.agent.env).toMatchObject({ ANTHROPIC_API_KEY: 'sk-test' })
  })

  it('threads the AcpRuntime into AcpClient', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    await registry.prompt('triage', { threadId: 't', content: [] })
    const opts = AcpClient.mock.calls[0][0]
    expect(opts.runtime).toBe(runtime)
  })

  it('links every established ACP session, including a resumed one', async () => {
    const linked = vi.fn()
    registry = new AcpAgentRegistry({
      runtime,
      agents: registry.opts.agents,
      onSessionEstablished: linked,
    })
    await registry.ensureSession('triage', 'thread|handoff', '!room:hs')
    await registry.ensureSession('triage', 'thread|handoff', '!room:hs')
    expect(linked).toHaveBeenCalledTimes(2)
    expect(linked).toHaveBeenLastCalledWith('triage', 'thread|handoff', 'acp-session-1')
  })

  it('releases the context binding when endSession() forgets the session', async () => {
    const ended = vi.fn()
    registry = new AcpAgentRegistry({
      runtime,
      agents: registry.opts.agents,
      onSessionEnded: ended,
    })
    await registry.ensureSession('triage', 'thread|handoff', '!room:hs')
    await registry.endSession('triage', 'thread|handoff')
    expect(ended).toHaveBeenCalledExactlyOnceWith('triage', 'thread|handoff')
  })

  it('releases the context binding when the ACP session closes on idle', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    const ended = vi.fn()
    const forwarded = vi.fn()
    registry = new AcpAgentRegistry({
      runtime,
      agents: registry.opts.agents,
      onLifecycle: forwarded,
      onSessionEnded: ended,
    })
    await registry.prompt('triage', { threadId: 't', content: [] })
    const opts = AcpClient.mock.calls[0][0] as { onLifecycle: (e: unknown) => void }
    const base = { agentId: 'triage', sessionKey: 't', sessionId: 'acp-session-1' }

    // An unsupported idle close leaves the session alive: keep its binding.
    opts.onLifecycle({ ...base, outcome: 'unsupported', reason: 'idle' })
    expect(ended).not.toHaveBeenCalled()

    opts.onLifecycle({ ...base, outcome: 'closed', reason: 'idle' })
    expect(ended).toHaveBeenCalledExactlyOnceWith('triage', 't')
    expect(forwarded).toHaveBeenCalledWith('triage', expect.objectContaining({ outcome: 'closed' }))
  })

  it('keeps the binding when a session restore fails before the new session starts', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    const ended = vi.fn()
    registry = new AcpAgentRegistry({
      runtime,
      agents: registry.opts.agents,
      onSessionEnded: ended,
    })
    await registry.prompt('triage', { threadId: 't', content: [] })
    const opts = AcpClient.mock.calls[0][0] as { onLifecycle: (e: unknown) => void }
    const base = { agentId: 'triage', sessionKey: 't', sessionId: 'acp-session-1' }

    // `AcpClient.ensureSession` emits this when resume/load throws, *before* it
    // falls through to newSession with the mcpServers minted a moment earlier.
    // The spawn is not dead — releasing it here would leave the fresh session
    // with a context server nobody owns, for the rest of its life.
    opts.onLifecycle({ ...base, outcome: 'failed', recoveryMethod: 'resume' })
    opts.onLifecycle({ ...base, outcome: 'failed', recoveryMethod: 'load' })
    expect(ended).not.toHaveBeenCalled()

    // A failed *close* is a real end: that path sets `reason`.
    opts.onLifecycle({ ...base, outcome: 'failed', reason: 'idle' })
    expect(ended).toHaveBeenCalledExactlyOnceWith('triage', 't')
  })

  it('stopAll() invokes stop on every started client', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    await registry.prompt('triage', { threadId: 't', content: [] })
    await registry.stopAll()
    const inst = AcpClient.mock.results[0].value as { stop: ReturnType<typeof vi.fn> }
    expect(inst.stop).toHaveBeenCalled()
  })

  it('replaces a dead cached client on the next dispatch instead of reusing it', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    await registry.prompt('triage', { threadId: 't1', content: [] })
    expect(AcpClient).toHaveBeenCalledTimes(1)
    const dead = AcpClient.mock.results[0].value as {
      isAlive: ReturnType<typeof vi.fn>
      stop: ReturnType<typeof vi.fn>
    }
    dead.isAlive.mockReturnValue(false)

    // Same conversation: the dead process is replaced, not reused.
    await registry.prompt('triage', { threadId: 't1', content: [] })
    expect(AcpClient).toHaveBeenCalledTimes(2)
    expect(dead.stop).toHaveBeenCalled()
    const fresh = AcpClient.mock.results[1].value as { start: ReturnType<typeof vi.fn> }
    expect(fresh.start).toHaveBeenCalled()
  })

  it('does not start duplicate clients for concurrent first dispatches of one conversation', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    await Promise.all([
      registry.ensureSession('triage', 't1'),
      registry.ensureSession('triage', 't1'),
      registry.ensureSession('triage', 't1'),
    ])
    expect(AcpClient).toHaveBeenCalledTimes(1)
  })

  it('stops a half-started client when start() rejects and does not cache it', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    const failedStop = vi.fn().mockResolvedValue(undefined)
    AcpClient.mockImplementationOnce(() => ({
      start: vi.fn().mockRejectedValue(new Error('handshake failed')),
      ensureSession: vi.fn(),
      prompt: vi.fn(),
      stop: failedStop,
      isAlive: vi.fn(() => false),
    }))
    await expect(registry.prompt('triage', { threadId: 't1', content: [] })).rejects.toThrow(
      /handshake failed/,
    )
    expect(failedStop).toHaveBeenCalled()
    // A failed start must not poison the cache: the next dispatch builds a
    // fresh client and succeeds.
    await expect(registry.prompt('triage', { threadId: 't2', content: [] })).resolves.toEqual({
      stopReason: 'end_turn',
    })
    expect(AcpClient).toHaveBeenCalledTimes(2)
  })

  it('clears the in-flight start map when start() rejects', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    AcpClient.mockImplementationOnce(() => ({
      start: vi.fn().mockRejectedValue(new Error('boom')),
      ensureSession: vi.fn(),
      prompt: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      isAlive: vi.fn(() => false),
    }))
    await expect(registry.ensureSession('triage', 't1')).rejects.toThrow(/boom/)
    await expect(registry.ensureSession('triage', 't2')).resolves.toBe('acp-session-1')
    expect(AcpClient).toHaveBeenCalledTimes(2)
  })

describe('AcpAgentRegistry — elicitation', () => {
  it('passes onElicitationRequest to the AcpClient only when a handler is set', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    AcpClient.mockClear()
    const handler = vi.fn(async () => ({ action: 'decline' as const }))
    registry.onElicitationRequest = handler
    await registry.prompt('triage', { threadId: 't', content: [{ type: 'text', text: 'hi' }] })
    const opts = AcpClient.mock.calls[0]![0] as {
      onElicitationRequest?: (req: unknown, signal: AbortSignal) => Promise<unknown>
    }
    expect(opts.onElicitationRequest).toBeTypeOf('function')
    const signal = new AbortController().signal
    const req = { sessionId: 's', message: 'm', requestedSchema: { type: 'object' } }
    await expect(opts.onElicitationRequest!(req, signal)).resolves.toEqual({ action: 'decline' })
    expect(handler).toHaveBeenCalledWith('triage', req, signal)
  })

  it('leaves onElicitationRequest undefined when no handler is set (no capability)', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    AcpClient.mockClear()
    await registry.prompt('builder', { threadId: 't', content: [{ type: 'text', text: 'hi' }] })
    const opts = AcpClient.mock.calls[0]![0] as { onElicitationRequest?: unknown }
    expect(opts.onElicitationRequest).toBeUndefined()
  })
})

})

describe('AcpAgentRegistry.cancelSession', () => {
  it('calls cancel on the AcpClient that owns the session and ApprovalCorrelator.cancelSession', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    AcpClient.mockClear()
    const correlator = {
      register: vi.fn(),
      resolve: vi.fn(),
      cancelSession: vi.fn(),
      listPending: vi.fn(() => []),
      on: vi.fn(),
      emit: vi.fn(),
    } as unknown as import('./approval-correlator.js').ApprovalCorrelator
    const registry = new AcpAgentRegistry({
      runtime: { spawn: vi.fn() } as never,
      agents: { architect: { acp: { command: 'noop' } } as never },
      approvals: correlator,
    })
    await registry.ensureSession('architect', 'thread-1')
    const fakeClient = AcpClient.mock.results.at(-1)!.value as {
      cancel: ReturnType<typeof vi.fn>
    }
    await registry.cancelSession('architect', 'sess-xyz')
    expect(fakeClient.cancel).toHaveBeenCalledWith('sess-xyz')
    expect((correlator as unknown as { cancelSession: ReturnType<typeof vi.fn> }).cancelSession).toHaveBeenCalledWith(
      'sess-xyz',
    )
  })

  it('routes an interrupt to the one process that owns the session, not its siblings', async () => {
    const { AcpClient } = (await import('@zooid/acp-client')) as unknown as {
      AcpClient: ReturnType<typeof vi.fn>
    }
    AcpClient.mockClear()
    const registry = new AcpAgentRegistry({
      runtime: { spawn: vi.fn() } as never,
      agents: { architect: { acp: { command: 'noop' } } as never },
    })
    await registry.ensureSession('architect', 'thread-a')
    await registry.ensureSession('architect', 'thread-b')
    const [a, b] = AcpClient.mock.results.map((r) => r.value as {
      ownsSession: ReturnType<typeof vi.fn>
      cancel: ReturnType<typeof vi.fn>
    })
    a!.ownsSession.mockReturnValue(false)
    b!.ownsSession.mockImplementation((id: string) => id === 'sess-b')
    await registry.cancelSession('architect', 'sess-b')
    expect(a!.cancel).not.toHaveBeenCalled()
    expect(b!.cancel).toHaveBeenCalledWith('sess-b')
  })

  it('is a no-op for an unknown agent', async () => {
    const correlator = {
      register: vi.fn(),
      resolve: vi.fn(),
      cancelSession: vi.fn(),
      listPending: vi.fn(() => []),
      on: vi.fn(),
      emit: vi.fn(),
    } as unknown as import('./approval-correlator.js').ApprovalCorrelator
    const registry = new AcpAgentRegistry({
      runtime: { spawn: vi.fn() } as never,
      agents: {},
      approvals: correlator,
    })
    await expect(registry.cancelSession('ghost', 'sess-xyz')).resolves.toBeUndefined()
    expect(
      (correlator as unknown as { cancelSession: ReturnType<typeof vi.fn> }).cancelSession,
    ).not.toHaveBeenCalled()
  })

  it('cancels pending approvals even when no client has been spawned yet', async () => {
    const correlator = {
      register: vi.fn(),
      resolve: vi.fn(),
      cancelSession: vi.fn(),
      listPending: vi.fn(() => []),
      on: vi.fn(),
      emit: vi.fn(),
    } as unknown as import('./approval-correlator.js').ApprovalCorrelator
    const registry = new AcpAgentRegistry({
      runtime: { spawn: vi.fn() } as never,
      agents: { architect: { acp: { command: 'noop' } } as never },
      approvals: correlator,
    })
    await registry.cancelSession('architect', 'sess-xyz')
    expect(
      (correlator as unknown as { cancelSession: ReturnType<typeof vi.fn> }).cancelSession,
    ).toHaveBeenCalledWith('sess-xyz')
  })
})

describe('AcpAgentRegistry — per-conversation processes', () => {
  const AGENTS = {
    triage: {
      name: 'triage',
      workdir: '.',
      hooks: {},
      acp: { command: 'opencode', args: ['acp'] },
      approval_timeout_ms: 0,
      session_idle_timeout_ms: 600_000,
    },
  }

  let runtime: StubRuntime
  let registry: InstanceType<typeof AcpAgentRegistry>
  let ended: ReturnType<typeof vi.fn>
  let AcpClient: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    const mod = (await import('@zooid/acp-client')) as unknown as { AcpClient: ReturnType<typeof vi.fn> }
    AcpClient = mod.AcpClient
    AcpClient.mockClear()
    runtime = new StubRuntime()
    ended = vi.fn()
    registry = new AcpAgentRegistry({
      runtime,
      agents: AGENTS as never,
      onSessionEnded: ended,
    })
  })

  afterEach(async () => {
    await registry.stopAll()
  })

  function instance(i: number) {
    return AcpClient.mock.results[i]!.value as {
      ensureSession: ReturnType<typeof vi.fn>
      endSession: ReturnType<typeof vi.fn>
      closeIdleSession: ReturnType<typeof vi.fn>
      stop: ReturnType<typeof vi.fn>
      isAlive: ReturnType<typeof vi.fn>
      isBusy: ReturnType<typeof vi.fn>
      hasLiveSessions: ReturnType<typeof vi.fn>
      canResumeSessions: ReturnType<typeof vi.fn>
      ownsSession: ReturnType<typeof vi.fn>
    }
  }

  it('two threads → two processes, each keyed to its own conversation', async () => {
    await registry.ensureSession('triage', '$threadA', '!room:hs', '$threadA')
    await registry.ensureSession('triage', '$threadB', '!room:hs', '$threadB')

    expect(AcpClient).toHaveBeenCalledTimes(2)
    const ids = AcpClient.mock.calls.map((c) => (c[0] as { instanceId: string }).instanceId)
    expect(ids).toEqual(['triage\u0000$threadA', 'triage\u0000$threadB'])
    expect(new Set(ids).size).toBe(2)
  })

  it('endSession stops that conversation’s process and leaves its siblings running', async () => {
    await registry.ensureSession('triage', '$threadA')
    await registry.ensureSession('triage', '$threadB')
    const [a, b] = [instance(0), instance(1)]

    await registry.endSession('triage', '$threadA')

    expect(a.ensureSession.mock.calls[0]).toEqual(['$threadA', undefined, undefined])
    expect(a.endSession).toHaveBeenCalledWith('$threadA')
    expect(a.stop).toHaveBeenCalled()
    expect(b.stop).not.toHaveBeenCalled()
    expect(ended.mock.calls).toEqual([['triage', '$threadA']])
  })

  it('idle reaper closes, stops and releases only conversations past their deadline', async () => {
    await registry.ensureSession('triage', '$threadA')
    await registry.ensureSession('triage', '$threadB')
    const [a, b] = [instance(0), instance(1)]
    a.hasLiveSessions.mockReturnValue(true)
    a.canResumeSessions.mockReturnValue(true)
    b.isBusy.mockReturnValue(true) // mid-turn: never reaped

    await registry.reapIdle(Date.now() + 300_001)

    expect(a.closeIdleSession).toHaveBeenCalledWith('$threadA')
    expect(a.stop).toHaveBeenCalled()
    expect(b.stop).not.toHaveBeenCalled()
    expect(ended.mock.calls).toEqual([['triage', '$threadA']])
  })

  it('does not reap a live session when the adapter cannot resume or load it', async () => {
    await registry.ensureSession('triage', '$threadA')
    const a = instance(0)
    a.hasLiveSessions.mockReturnValue(true)
    a.canResumeSessions.mockReturnValue(false)

    await registry.reapIdle(Date.now() + 300_001)

    expect(a.closeIdleSession).not.toHaveBeenCalled()
    expect(a.stop).not.toHaveBeenCalled()
  })

  it('opens a per-conversation circuit after repeated quick crashes and leaves other threads alone', async () => {
    const crash = () =>
      AcpClient.mockImplementationOnce(() => ({
        start: vi.fn().mockRejectedValue(new Error('boom')),
        stop: vi.fn().mockResolvedValue(undefined),
        isAlive: vi.fn(() => false),
      }))

    for (let i = 0; i < 3; i++) {
      crash()
      await expect(registry.ensureSession('triage', '$bad')).rejects.toThrow(/boom/)
    }
    // The circuit is open: no fourth spawn is attempted.
    await expect(registry.ensureSession('triage', '$bad')).rejects.toThrow(/refusing to spawn/)
    // A different conversation is unaffected.
    await expect(registry.ensureSession('triage', '$good')).resolves.toBe('acp-session-1')
  })

  it('does not spawn two processes when two dispatches queue behind one reap', async () => {
    await registry.ensureSession('triage', '$threadA')
    const a = instance(0)
    let releaseClose!: () => void
    a.closeIdleSession.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve
        }),
    )
    const reaping = registry.reapIdle(Date.now() + 300_001)
    // The reaper publishes `stopping` synchronously, before the close resolves.
    const first = registry.ensureSession('triage', '$threadA')
    const second = registry.ensureSession('triage', '$threadA')
    releaseClose()
    await Promise.all([reaping, first, second])
    // Old process + exactly one replacement, not one per queued dispatch.
    expect(AcpClient).toHaveBeenCalledTimes(2)
  })

  it('makes a dispatch during endSession wait for the teardown instead of using the doomed process', async () => {
    await registry.ensureSession('triage', '$threadA')
    const a = instance(0)
    let releaseEnd!: () => void
    a.endSession.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseEnd = resolve
        }),
    )
    const ending = registry.endSession('triage', '$threadA')
    const next = registry.ensureSession('triage', '$threadA')
    // The process being ended is out of service before its close resolves.
    expect(AcpClient).toHaveBeenCalledTimes(1)
    releaseEnd()
    await Promise.all([ending, next])
    expect(AcpClient).toHaveBeenCalledTimes(2)
    expect(a.stop).toHaveBeenCalled()
  })

  it('shares one session store per agent across its per-conversation clients', async () => {
    registry = new AcpAgentRegistry({
      runtime,
      agents: AGENTS as never,
      agentsDir: '/tmp/zooid-sessions-shared',
    })
    AcpClient.mockClear()
    await registry.ensureSession('triage', '$threadA')
    await registry.ensureSession('triage', '$threadB')
    const stores = AcpClient.mock.calls.map(
      (c) => (c[0] as { sessionStore?: unknown }).sessionStore,
    )
    expect(stores[0]).toBeDefined()
    expect(stores[0]).toBe(stores[1])
  })
})

describe('AcpAgentRegistry.cancelSession — elicitation', () => {
  it('cancels open elicitations for the session with reason interrupt', async () => {
    const elicitations = { cancelSession: vi.fn(() => 1) }
    const r = new AcpAgentRegistry({
      runtime: new StubRuntime(),
      agents: {
        architect: { name: 'architect', workdir: '.', hooks: {}, acp: { preset: 'claude' }, approval_timeout_ms: 0 },
      },
      elicitations: elicitations as never,
    })
    await r.cancelSession('architect', 'sess-xyz')
    expect(elicitations.cancelSession).toHaveBeenCalledWith('sess-xyz', 'interrupt')
  })
})
