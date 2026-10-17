import { describe, it, expect, vi, afterEach } from 'vitest'
import { loadZooidConfig } from './config.js'

const HTTP = `
transports:
  http-local:
    type: http
    port: 8080
`

function agent(name: string, extra = ''): string {
  return `  ${name}:
    workdir: ./${name}
    acp: { command: node, args: [agent.mjs] }
    http: { transport: http-local }
${extra}`
}

function yaml(top: string, ...agents: string[]): string {
  return `${top}\n${HTTP.trimStart()}agents:\n${agents.join('')}`
}

const vm = (block: string) => loadZooidConfig(yaml('runtime: vm', agent('smoke', `    vm: ${block}\n`)))

const HOSTS_MSG = /agents\.smoke\.vm\.allow_hosts must be a non-empty list of host names like "github\.com"/

describe('ZOD128: vm.allow_hosts', () => {
  it('accepts a list of host names', () => {
    const cfg = vm('{ allow_hosts: [github.com, registry.npmjs.org] }')
    expect(cfg.agents.smoke!.vm).toEqual({ allow_hosts: ['github.com', 'registry.npmjs.org'] })
  })

  it('rejects an empty allow_hosts', () => {
    expect(() => vm('{ allow_hosts: [] }')).toThrow(HOSTS_MSG)
  })

  it.each(['https://github.com', 'github.com:443', 'github.com/x', '*.github.com'])(
    'rejects %s in allow_hosts, naming it',
    (bad) => {
      expect(() => vm(`{ allow_hosts: ["${bad}"] }`)).toThrow(HOSTS_MSG)
      expect(() => vm(`{ allow_hosts: ["${bad}"] }`)).toThrow(JSON.stringify(bad))
    },
  )

  it('vm.git is gone: env carries a remote now', () => {
    expect(() => vm('{ git: "https://github.com/x.git", allow_hosts: [github.com] }')).toThrow(
      'agents.smoke.vm.git is not a recognised field (image, cpus, memory, disk, allow_hosts, env, mounts)',
    )
  })
})

describe('vm.env: container.env for a vm agent', () => {
  afterEach(() => vi.unstubAllEnvs())
  const vmEnv = (block: string) => loadZooidConfig(yaml('runtime: vm', agent('smoke', `    vm: ${block}\n`)))

  it('passes a string mapping through', () => {
    const cfg = vmEnv('{ env: { SMOKE_GIT: "https://github.com/zooid-ai/zooid.git", PI_CODING_AGENT_DIR: /pi } }')
    expect(cfg.agents.smoke!.vm?.env).toEqual({
      SMOKE_GIT: 'https://github.com/zooid-ai/zooid.git',
      PI_CODING_AGENT_DIR: '/pi',
    })
  })

  it('interpolates ${VAR} from the daemon env, like container.env', () => {
    vi.stubEnv('SMOKE_KEY', 'sk-test')
    const cfg = vmEnv('{ env: { OPENAI_API_KEY: "${SMOKE_KEY}" } }')
    expect(cfg.agents.smoke!.vm?.env).toEqual({ OPENAI_API_KEY: 'sk-test' })
  })

  it('rejects ZOOID_* keys, like container.env', () => {
    expect(() => vmEnv('{ env: { ZOOID_X: y } }')).toThrow(
      'agents.smoke.vm.env.ZOOID_X: keys in the ZOOID_* namespace are not allowed',
    )
  })

  it('rejects a non-mapping and non-string values', () => {
    expect(() => vmEnv('{ env: [a] }')).toThrow('agents.smoke.vm.env must be a mapping')
    expect(() => vmEnv('{ env: { N: 3 } }')).toThrow('agents.smoke.vm.env.N: must be a string (got number)')
  })
})

describe('vm.mounts: operator directories, container.mounts entries', () => {
  const vmMounts = (entries: string) =>
    loadZooidConfig(yaml('runtime: vm', agent('smoke', `    vm:\n      mounts:\n${entries}`)), {
      configDir: '/wf',
    })

  it('resolves host paths against the config dir and defaults mode to rw', () => {
    const cfg = vmMounts('        - { host: ./logins/pi, target: /pi }\n        - { host: /data/ref, target: /ref, mode: ro, create: true }\n')
    expect(cfg.agents.smoke!.vm?.mounts).toEqual([
      { host: '/wf/logins/pi', target: '/pi', mode: 'rw' },
      { host: '/data/ref', target: '/ref', mode: 'ro', create: true },
    ])
  })

  it('refuses the workdir path as a target', () => {
    expect(() => vmMounts('        - { host: /x, target: /workspace }\n')).toThrow(
      'agents.smoke.vm.mounts[0].target: /workspace is the agent\'s read-only workdir',
    )
  })

  it('has no id: a vm agent has no preset mounts to subtract from', () => {
    expect(() => vmMounts('        - { id: pi, host: /x, target: /pi }\n')).toThrow(
      'agents.smoke.vm.mounts[0].id is not supported',
    )
  })

  it('names vm.mounts in shape errors', () => {
    expect(() => vmMounts('        - { host: /x }\n')).toThrow('agents.smoke.vm.mounts[0].target is required')
    expect(() => vmMounts('        - { host: /x, target: /y, mode: rx }\n')).toThrow(
      'agents.smoke.vm.mounts[0].mode must be "ro" or "rw"',
    )
  })

  it('a non-list is refused', () => {
    expect(() => vm('{ mounts: { a: b } }')).toThrow('agents.smoke.vm.mounts must be an array')
  })
})
