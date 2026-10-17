import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentConfig, ZooidConfig } from '@zooid/core'
import { existsSync } from 'node:fs'
import { vmMachineName, type VmExec, type VmExecResult } from '@zooid/runtime-vm'
import { provisionVms } from './provision-vms.js'

let configDir: string
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'zod109-prov-'))
  for (const n of ['lead', 'smoke']) mkdirSync(join(configDir, 'agents', n), { recursive: true })
})
afterEach(() => rmSync(configDir, { recursive: true, force: true }))

function agent(name: string, over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name,
    workdir: `./agents/${name}`,
    hooks: {},
    acp: { command: 'node', args: ['agent.mjs'] },
    approval_timeout_ms: 0,
    session_idle_timeout_ms: 0,
    http: { transport: 'http-local' },
    ...over,
  }
}

const config = (): ZooidConfig =>
  ({
    runtime: 'local',
    transports: { 'http-local': { type: 'http', port: 8080 } },
    agents: {
      lead: agent('lead'),
      smoke: agent('smoke', { runtime: 'vm', vm: { image: 'node:22-alpine', memory_mib: 1024 } }),
    },
    hooks: {},
  }) as ZooidConfig

function fakeExec() {
  const calls: string[][] = []
  const exec: VmExec = vi.fn(async (cmd, args) => {
    calls.push([cmd, ...args])
    return { code: 0, stdout: args[1] === 'ls' ? '[]' : '', stderr: '' }
  })
  return { exec, calls }
}

describe('provisionVms', () => {
  it('creates and starts one machine per vm agent, with the absolute workdir mounted read-only', async () => {
    const { exec, calls } = fakeExec()
    const handle = await provisionVms({
      cfg: config(),
      configDir,
      agentsDir: join(configDir, '.data', 'agents'),
      exec,
      log: () => {},
    })
    const name = vmMachineName('smoke', configDir)
    expect(handle.machines).toEqual([name])
    const create = calls.find((c) => c[2] === 'create')!
    expect(create).toContain(name)
    expect(create).toContain(`${join(configDir, 'agents', 'smoke')}:/workspace:ro`)
    expect(create).toContain('--mem')
    expect(calls.some((c) => c[2] === 'start')).toBe(true)
  })

  it('touches nothing when no agent resolves to vm', async () => {
    const { exec, calls } = fakeExec()
    const c = config()
    delete c.agents.smoke
    const handle = await provisionVms({ cfg: c, configDir, exec, log: () => {} })
    expect(handle.machines).toEqual([])
    expect(calls).toEqual([])
  })

  it('stop() stops every provisioned machine', async () => {
    const { exec, calls } = fakeExec()
    const handle = await provisionVms({ cfg: config(), configDir, exec, log: () => {} })
    calls.length = 0
    await handle.stop()
    expect(calls).toEqual([['smolvm', 'machine', 'stop', '--name', vmMachineName('smoke', configDir)]])
  })

  it('fails daemon start when a vm workdir holds secrets', async () => {
    writeFileSync(join(configDir, 'agents', 'smoke', '.env'), 'TOKEN=x')
    const { exec } = fakeExec()
    await expect(provisionVms({ cfg: config(), configDir, exec, log: () => {} })).rejects.toThrow(/\.env/)
  })
})

describe('provisionVms — egress, operator mounts and local images', () => {
  type Rec = { name: string; state: string }
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'zod128-home-'))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const piSmoke = (vm: AgentConfig['vm'] = {}) =>
    agent('smoke', {
      runtime: 'vm',
      acp: { preset: 'pi' } as AgentConfig['acp'],
      vm: { image: 'node:22-alpine', allow_hosts: ['github.com'], ...vm },
    })
  const cfgWith = (smoke: AgentConfig): ZooidConfig => ({ ...config(), agents: { lead: agent('lead'), smoke } })

  function recorder(machines: Rec[] = [], fail?: (args: string[]) => VmExecResult | undefined) {
    const calls: string[][] = []
    const exec: VmExec = vi.fn(async (_cmd, args) => {
      calls.push(args)
      const failed = fail?.(args)
      if (failed) return failed
      const [, sub] = args
      const name = args[args.indexOf('--name') + 1]!
      if (sub === 'ls') return { code: 0, stdout: JSON.stringify(machines), stderr: '' }
      if (sub === 'create') machines.push({ name, state: 'stopped' })
      if (sub === 'start') machines.find((m) => m.name === name)!.state = 'running'
      if (sub === 'delete') machines.splice(machines.findIndex((m) => m.name === name), 1)
      return { code: 0, stdout: '', stderr: '' }
    })
    return { exec, calls }
  }

  const run = (c: ZooidConfig, r: ReturnType<typeof recorder>) =>
    provisionVms({
      cfg: c,
      configDir,
      agentsDir: join(configDir, '.data', 'agents'),
      daemonHome: home,
      exec: r.exec,
      log: () => {},
    })

  it('a pi vm agent gets the allowlisted network and nothing preset-specific: no socket, no guest setup', async () => {
    const r = recorder()
    await run(cfgWith(piSmoke()), r)
    const create = r.calls.find((c) => c[1] === 'create')!
    expect(create.join(' ')).toContain('--net --allow-host github.com')
    expect(create).not.toContain('--mount-socket')
    // The only exec is ensureVmMachine settling a networked machine (smolvm kills the first exec).
    const execs = r.calls.filter((c) => c[1] === 'exec').map((c) => c.slice(c.indexOf('--') + 1))
    expect(execs).toEqual([['sleep', '1']])
  })

  it('passes vm.mounts to create, rw by default and :ro when asked', async () => {
    const login = join(home, 'login')
    const ref = join(home, 'ref')
    mkdirSync(login)
    mkdirSync(ref)
    const r = recorder()
    await run(
      cfgWith(
        piSmoke({
          mounts: [
            { host: login, target: '/pi', mode: 'rw' },
            { host: ref, target: '/ref', mode: 'ro' },
          ],
        }),
      ),
      r,
    )
    const create = r.calls.find((c) => c[1] === 'create')!.join(' ')
    expect(create).toContain(`-v ${login}:/pi -v ${ref}:/ref:ro`)
  })

  it('creates a mount host dir when the entry says create: true, like container.mounts', async () => {
    const login = join(home, 'new-login')
    await run(cfgWith(piSmoke({ mounts: [{ host: login, target: '/pi', mode: 'rw', create: true }] })), recorder())
    expect(existsSync(login)).toBe(true)
  })

  it('refuses a missing mount dir without create, before smolvm', async () => {
    const r = recorder()
    await expect(
      run(cfgWith(piSmoke({ mounts: [{ host: join(home, 'nope'), target: '/pi', mode: 'rw' }] })), r),
    ).rejects.toThrow(`vm mount ${join(home, 'nope')} is not a directory`)
    expect(r.calls.filter((c) => c[1] === 'create')).toEqual([])
  })

  it('resolves a local image against the config dir and recreates the machine when it is rebuilt', async () => {
    const img = join(configDir, 'img.tar')
    writeFileSync(img, 'v1')
    utimesSync(img, 1000, 1000)
    const machines: Rec[] = []
    const first = recorder(machines)
    await run(cfgWith(piSmoke({ image: './img.tar' })), first)
    expect(first.calls.find((c) => c[1] === 'create')).toEqual(expect.arrayContaining(['--image', img]))
    utimesSync(img, 2000, 2000)
    const second = recorder(machines)
    await run(cfgWith(piSmoke({ image: './img.tar' })), second)
    const subs = second.calls.map((c) => c[1])
    expect(subs.indexOf('delete')).toBeGreaterThan(-1)
    expect(second.calls.find((c) => c[1] === 'delete')).toContain('--force')
    expect(subs.indexOf('create')).toBeGreaterThan(subs.indexOf('delete'))
  })

  it('fails early on a missing local image, before smolvm', async () => {
    const r = recorder()
    await expect(run(cfgWith(piSmoke({ image: '~/missing.tar' })), r)).rejects.toThrow(
      `vm image ${join(home, 'missing.tar')} does not exist`,
    )
    expect(r.calls).toEqual([])
  })
})
