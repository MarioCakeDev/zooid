import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AcpAgentRegistry } from '../src/acp-registry.js'
import type { AcpRuntime, AcpSpawnSpec } from '../src/acp-types.js'
import type { AgentConfig } from '../src/types.js'

/**
 * The acceptance gate for daemon-side containment (wayfinder 06/07): the
 * daemon must run **one ACP process per zooid conversation**, and each
 * session's ACP `mcpServers` catalog must carry **only that conversation's**
 * `zooid-context` server.
 *
 * The real `AcpClient` is used here — no mocks — so what is asserted is the
 * bytes that reach an agent process. A tiny probe agent (fixtures/
 * thread-probe-agent.mjs) records the `mcpServers` it is handed on `session/new`.
 * Two threads ⇒ two OS processes (distinct pids) ⇒ two catalogs, each with
 * exactly one context server, and the two servers are different spawn ids.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PROBE = join(HERE, 'fixtures', 'thread-probe-agent.mjs')

interface RecordedSession {
  pid: number
  sessionId: string
  mcpServers: Array<{ name: string; command: string; args: string[] }>
}

interface Spawned {
  spec: AcpSpawnSpec
  child: ChildProcess
}

describe('per-thread ACP process isolation (real processes)', () => {
  let dir: string
  let recordFile: string
  let spawns: Spawned[]
  let ended: Array<[string, string]>
  let registry: AcpAgentRegistry

  const spawnIdsBySessionKey = new Map<string, string>()

  function runtime(): AcpRuntime {
    return {
      spawn: (spec) => {
        const child = spawn(process.execPath, [PROBE], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, RECORD_FILE: recordFile },
          cwd: dir,
        })
        spawns.push({ spec, child })
        return child
      },
    }
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zooid-thread-isolation-'))
    recordFile = join(dir, 'records.jsonl')
    spawns = []
    ended = []
    spawnIdsBySessionKey.clear()
  })

  afterEach(async () => {
    await registry?.stopAll()
    await rm(dir, { recursive: true, force: true })
  })

  function build(): void {
    const probe = {
      name: 'probe',
      workdir: dir,
      hooks: {},
      acp: { command: 'unused-in-this-test' },
      approval_timeout_ms: 0,
      session_idle_timeout_ms: 0,
    } as unknown as AgentConfig

    registry = new AcpAgentRegistry({
      runtime: runtime(),
      agents: { probe },
      cwd: { probe: dir },
      agentsDir: join(dir, 'agents'),
      timeouts: { initializeMs: 20_000, sessionMs: 20_000, firstResponseMs: 20_000 },
      // The daemon's per-spawn context server. One spawn id per session key,
      // exactly like `buildContextSpawns` → `SpawnRegistry.register`.
      contextSpawns: {
        probe: async (threadRoot, channelId, sessionKey) => {
          void threadRoot
          void channelId
          const key = sessionKey!
          const spawnId = `spawn-${key}`
          spawnIdsBySessionKey.set(key, spawnId)
          return {
            name: 'zooid-context',
            command: process.execPath,
            args: ['-e', '/* context stub; never executed by the probe */', '--spawn-id', spawnId],
            env: [{ name: 'ZOOID_SESSION_KEY', value: key }],
          }
        },
      },
      onSessionEnded: (agent, key) => ended.push([agent, key]),
    })
  }

  async function records(): Promise<RecordedSession[]> {
    const raw = await readFile(recordFile, 'utf8')
    return raw
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as RecordedSession)
  }

  it('two threads → two processes, and each catalog holds only its own zooid-context server', async () => {
    build()

    await registry.ensureSession('probe', '$threadA', '!room:hs', '$threadA')
    await registry.ensureSession('probe', '$threadB', '!room:hs', '$threadB')

    // Two OS processes, each keyed to one conversation.
    expect(spawns).toHaveLength(2)
    expect(spawns[0]!.spec.spawnKey).toBe('probe\u0000$threadA')
    expect(spawns[1]!.spec.spawnKey).toBe('probe\u0000$threadB')
    expect(spawns[0]!.child.pid).toBeTypeOf('number')
    expect(spawns[1]!.child.pid).toBeTypeOf('number')
    expect(spawns[0]!.child.pid).not.toBe(spawns[1]!.child.pid)

    // One session per process, and each tool catalog carries exactly one
    // zooid-context server: its own, never the other thread's.
    const rows = await records()
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.pid)).size).toBe(2)

    for (const row of rows) {
      expect(row.mcpServers).toHaveLength(1)
      expect(row.mcpServers[0]!.name).toBe('zooid-context')
      const spawnArg = row.mcpServers[0]!.args[row.mcpServers[0]!.args.indexOf('--spawn-id') + 1]
      expect(spawnArg).toMatch(/^spawn-\$thread[AB]$/)
    }

    const catalogs = rows.map((row) => {
      const args = row.mcpServers[0]!.args
      return args[args.indexOf('--spawn-id') + 1]
    })
    expect(new Set(catalogs)).toEqual(new Set(['spawn-$threadA', 'spawn-$threadB']))

    // …and each catalog belongs to the process that serves that thread: the
    // spawn key on the OS process and the spawn id in its session agree.
    for (const { spec, child } of spawns) {
      const key = spec.spawnKey!.split('\u0000')[1]!
      const row = rows.find((r) => r.pid === child.pid)!
      const args = row.mcpServers[0]!.args
      expect(args[args.indexOf('--spawn-id') + 1]).toBe(spawnIdsBySessionKey.get(key))
    }
  })

  it('reuses one thread’s process across turns, and starting another thread never respawns it', async () => {
    build()

    await registry.ensureSession('probe', '$threadA', '!room:hs', '$threadA')
    await registry.ensureSession('probe', '$threadA', '!room:hs', '$threadA')
    expect(spawns).toHaveLength(1)
    expect(await records()).toHaveLength(1)

    await registry.ensureSession('probe', '$threadB', '!room:hs', '$threadB')
    expect(spawns).toHaveLength(2)
    // Thread A's process was not reaped or duplicated by thread B's spawn.
    expect(spawns[0]!.child.exitCode).toBeNull()
  })

  it('ending one thread stops only its process; the sibling keeps serving its session', async () => {
    build()

    await registry.ensureSession('probe', '$threadA', '!room:hs', '$threadA')
    await registry.ensureSession('probe', '$threadB', '!room:hs', '$threadB')
    const [a, b] = spawns

    await registry.endSession('probe', '$threadA')

    expect(ended).toEqual([['probe', '$threadA']])
    await expect
      .poll(() => a!.child.exitCode ?? a!.child.signalCode, { timeout: 5_000 })
      .not.toBeNull()
    expect(b!.child.exitCode).toBeNull()
    expect(b!.child.signalCode).toBeNull()

    // The surviving thread still answers without a new process.
    await expect(registry.ensureSession('probe', '$threadB', '!room:hs', '$threadB')).resolves.toBeTypeOf(
      'string',
    )
    expect(spawns).toHaveLength(2)

    // A ended conversation starts a fresh process on its next turn.
    await registry.ensureSession('probe', '$threadA', '!room:hs', '$threadA')
    expect(spawns).toHaveLength(3)
  })

  it('idle reaping stops an idle thread process and releases its context spawn', async () => {
    build()
    await registry.ensureSession('probe', '$threadA', '!room:hs', '$threadA')
    const [a] = spawns

    await registry.reapIdle(Date.now() + 300_001)

    expect(ended).toEqual([['probe', '$threadA']])
    await expect
      .poll(() => a!.child.exitCode ?? a!.child.signalCode, { timeout: 5_000 })
      .not.toBeNull()
  })
})
