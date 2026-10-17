import { describe, it, expect } from 'vitest'
import { VmAcpRuntime } from '@zooid/runtime-vm'
import type { AgentConfig, ZooidConfig } from '@zooid/core'
import { buildAcpRegistry } from './build-registry.js'

const CONFIG_DIR = '/tmp/zod128-workforce'

function agent(name: string, over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name,
    workdir: `./agents/${name}`,
    hooks: {},
    acp: { preset: 'pi' } as AgentConfig['acp'],
    approval_timeout_ms: 0,
    session_idle_timeout_ms: 0,
    http: { transport: 'http-local' },
    ...over,
  }
}

const cfg = (agents: Record<string, AgentConfig>): ZooidConfig =>
  ({
    runtime: 'local',
    transports: { 'http-local': { type: 'http', port: 8080 } },
    agents,
    hooks: {},
  }) as ZooidConfig

const smoke = (vm: AgentConfig['vm'] = {}) =>
  agent('smoke', { runtime: 'vm', vm: { image: 'i', allow_hosts: ['github.com'], ...vm } })

const build = (c: ZooidConfig) => buildAcpRegistry(c, { configDir: CONFIG_DIR, log: () => {} })

describe('vm agent env: vm.env, nothing implicit', () => {
  it('a vm pi agent gets exactly its vm.env', () => {
    const reg = build(cfg({ smoke: smoke({ env: { PI_CODING_AGENT_DIR: '/pi', SMOKE_GIT: 'https://x/y.git' } }) }))
    expect(reg.resolveSpawnEnv('smoke')).toEqual({ PI_CODING_AGENT_DIR: '/pi', SMOKE_GIT: 'https://x/y.git' })
  })

  it('no vm.env, no env: the pi preset adds nothing for vm', () => {
    const reg = build(cfg({ smoke: smoke() }))
    expect(reg.resolveSpawnEnv('smoke')).toEqual({})
  })

  it('a local pi agent beside it keeps its container env', () => {
    const lead = agent('lead')
    const reg = build(cfg({ lead, smoke: smoke({ env: { A: 'b' } }) }))
    expect(reg.resolveSpawnEnv('lead')).toEqual({})
  })

  it('the vm exec argv carries the env ahead of the command', () => {
    const reg = build(cfg({ smoke: smoke({ env: { PI_CODING_AGENT_DIR: '/pi' } }) }))
    const argv = new VmAcpRuntime({ machine: 'm' }).buildArgv({
      command: 'npx',
      args: ['-y', 'pi-acp'],
      env: reg.resolveSpawnEnv('smoke'),
      cwd: reg.resolveSpawnCwd('smoke'),
    })
    expect(argv.indexOf('PI_CODING_AGENT_DIR=/pi')).toBeGreaterThan(-1)
    expect(argv.indexOf('PI_CODING_AGENT_DIR=/pi')).toBeLessThan(argv.indexOf('npx'))
  })
})
