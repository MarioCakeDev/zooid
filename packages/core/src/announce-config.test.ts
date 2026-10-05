import { describe, it, expect } from 'vitest'
import { loadZooidConfig } from './config.js'

/**
 * `announce` is the opt-in switch for the thread completion notice. It is a
 * workforce-level default (`announce.thread_completion`) with a narrower
 * per-agent override of the same boolean. Everything defaults off: absent
 * means no announcement, so the parsed object must not gain the key unless it
 * was actually configured.
 */
const YAML = (extra: string) => `
runtime: local
transports:
  http-local:
    type: http
    port: 8080
agents:
  qa:
    workdir: ./qa
    acp:
      preset: claude
    http:
      transport: http-local
${extra}
`

describe('workforce-level announce config', () => {
  it('is absent (undefined) when unset — the feature defaults off', () => {
    const config = loadZooidConfig(YAML(''))
    expect(config.announce).toBeUndefined()
  })

  it('parses thread_completion', () => {
    const config = loadZooidConfig(YAML('announce:\n  thread_completion: true'))
    expect(config.announce).toEqual({ thread_completion: true })
  })

  it('rejects a non-boolean flag', () => {
    expect(() =>
      loadZooidConfig(YAML('announce:\n  thread_completion: "yes"')),
    ).toThrow(/announce\.thread_completion must be a boolean/)
  })

  it('parses status_room (trimmed)', () => {
    const config = loadZooidConfig(YAML('announce:\n  status_room: "#status"'))
    expect(config.announce).toEqual({ status_room: '#status' })
    const spaced = loadZooidConfig(YAML('announce:\n  status_room: "  #status:example.org  "'))
    expect(spaced.announce?.status_room).toBe('#status:example.org')
  })

  it('leaves status_room undefined when absent', () => {
    const config = loadZooidConfig(YAML('announce:\n  thread_completion: true'))
    expect(config.announce?.status_room).toBeUndefined()
  })

  it('rejects a non-string or empty status_room', () => {
    expect(() => loadZooidConfig(YAML('announce:\n  status_room: 42'))).toThrow(
      /announce\.status_room must be a non-empty string/,
    )
    expect(() => loadZooidConfig(YAML('announce:\n  status_room: "   "'))).toThrow(
      /announce\.status_room must be a non-empty string/,
    )
  })
})

describe('per-agent announce override', () => {
  it('parses a per-agent thread_completion override', () => {
    const config = loadZooidConfig(YAML('    announce:\n      thread_completion: false'))
    expect(config.agents.qa!.announce).toEqual({ thread_completion: false })
  })

  it('is absent when the agent does not override', () => {
    const config = loadZooidConfig(YAML(''))
    expect(config.agents.qa!.announce).toBeUndefined()
  })

  it('rejects a non-boolean per-agent flag', () => {
    expect(() =>
      loadZooidConfig(YAML('    announce:\n      thread_completion: 1')),
    ).toThrow(/agents\.qa\.announce\.thread_completion must be a boolean/)
  })

  it('ignores status_room at the agent level (workforce-only)', () => {
    const config = loadZooidConfig(YAML('    announce:\n      status_room: "#status"'))
    expect(config.agents.qa!.announce).toBeUndefined()
  })
})
