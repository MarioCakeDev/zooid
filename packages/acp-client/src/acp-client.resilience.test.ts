import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { AcpClient } from './acp-client.js'

/**
 * Regression tests for the 2026-09-22 daemon hang: a dead / never-replying
 * child must fail the handshake instead of blocking `ensureSession` forever,
 * and the client must report itself dead so the registry replaces it.
 */

class SilentChild extends EventEmitter {
  stdout = new Readable({ read() {} })
  stdin = new Writable({ write(_c, _e, cb) { cb() } })
  stderr = new Readable({ read() {} })
  pid = 1
  kill = vi.fn(() => true)
}

function makeClient(opts: { child: SilentChild; initializeMs?: number; sessionMs?: number }) {
  const rt = { spawn: vi.fn().mockReturnValue(opts.child as unknown as ChildProcess) }
  const client = new AcpClient({
    agent: { id: 'dev', command: 'opencode', args: ['acp'] },
    onEvent: () => {},
    onApprovalRequest: async () => ({ decision: 'cancel' }),
    runtime: rt,
    timeouts: { initializeMs: opts.initializeMs, sessionMs: opts.sessionMs },
  })
  return { client, rt }
}

function stubConnection(client: AcpClient, connection: Record<string, unknown>) {
  ;(client as unknown as { connection: unknown }).connection = connection
  ;(client as unknown as { initialized: boolean }).initialized = true
  ;(client as unknown as { agentCapabilities: { loadSession?: boolean } }).agentCapabilities = {}
}

/** Attach the child-exit/error watcher without going through start(). */
function watchChild(client: AcpClient, child: SilentChild) {
  ;(client as unknown as { watchChild: (c: EventEmitter, s: string) => void }).watchChild(
    child,
    'child',
  )
}

describe('AcpClient handshake resilience', () => {
  it('rejects start() within the timeout when the child never replies to initialize', async () => {
    const child = new SilentChild()
    const { client } = makeClient({ child, initializeMs: 40 })
    await expect(client.start()).rejects.toThrow(/initialize timed out after 40ms/i)
    expect(client.isAlive()).toBe(false)
  })

  it('marks the client dead and fails promptly when the child exits mid-handshake', async () => {
    const child = new SilentChild()
    const { client } = makeClient({ child, initializeMs: 60_000 })
    const started = client.start()
    setTimeout(() => child.emit('exit', 1, null), 10)
    await expect(started).rejects.toThrow(/exited/i)
    expect(client.isAlive()).toBe(false)
  })

  it('rejects ensureSession within the timeout when newSession never resolves', async () => {
    const child = new SilentChild()
    const { client } = makeClient({ child, sessionMs: 40 })
    stubConnection(client, {
      newSession: vi.fn(() => new Promise(() => {})),
      loadSession: vi.fn(() => new Promise(() => {})),
    })
    await expect(client.ensureSession('thread-1')).rejects.toThrow(/newSession timed out after 40ms/i)
    // A handshake timeout means the connection is wedged: the client must
    // report dead so the registry drops + replaces it on the next dispatch.
    expect(client.isAlive()).toBe(false)
  })

  it('does not fall back to newSession when loadSession times out', async () => {
    const child = new SilentChild()
    const { client } = makeClient({ child, sessionMs: 40 })
    const newSession = vi.fn(() => new Promise(() => {}))
    stubConnection(client, {
      newSession,
      loadSession: vi.fn(() => new Promise(() => {})),
    })
    ;(client as unknown as { agentCapabilities: { loadSession?: boolean } }).agentCapabilities = {
      loadSession: true,
    }
    ;(client as unknown as { store: unknown }).store = {
      get: () => 'persisted-session',
      delete: vi.fn(async () => {}),
      load: vi.fn(async () => {}),
    }
    ;(client as unknown as { storeLoaded: Promise<void> }).storeLoaded = Promise.resolve()
    await expect(client.ensureSession('thread-1')).rejects.toThrow(/loadSession.*timed out/i)
    expect(newSession).not.toHaveBeenCalled()
    expect(client.isAlive()).toBe(false)
  })

  it('rejects ensureSession when the child exits while a session is being established', async () => {
    const child = new SilentChild()
    const { client } = makeClient({ child, sessionMs: 60_000 })
    watchChild(client, child)
    stubConnection(client, {
      newSession: vi.fn(() => new Promise(() => {})),
      loadSession: vi.fn(() => new Promise(() => {})),
    })
    const pending = client.ensureSession('thread-1')
    setTimeout(() => child.emit('error', new Error('EPIPE')), 10)
    await expect(pending).rejects.toThrow(/EPIPE/i)
  })

  it('rejects ensureSession on an already-dead client without touching the connection', async () => {
    const child = new SilentChild()
    const { client } = makeClient({ child })
    watchChild(client, child)
    const newSession = vi.fn(() => new Promise(() => {}))
    stubConnection(client, { newSession, loadSession: vi.fn() })
    child.emit('exit', 0, null)
    await expect(client.ensureSession('thread-1')).rejects.toThrow(/exited/i)
    expect(newSession).not.toHaveBeenCalled()
  })

  it('isAlive() is false after stop()', async () => {
    const child = new SilentChild()
    const { client } = makeClient({ child })
    stubConnection(client, { newSession: vi.fn(), loadSession: vi.fn() })
    expect(client.isAlive()).toBe(true)
    await client.stop()
    expect(client.isAlive()).toBe(false)
  })
})
