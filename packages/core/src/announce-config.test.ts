import { describe, it, expect } from 'vitest'
import { loadZooidConfig } from './config.js'

/**
 * `announce` is the opt-in switch for the human-thread completion notice.
 * It is a workforce-level default (`announce.human_thread_completion` +
 * `announce.owner_mxid`) with a narrower per-agent override of just the
 * boolean. Everything defaults off: absent means no announcement, so the
 * parsed object must not gain the key unless it was actually configured.
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

  it('parses human_thread_completion and owner_mxid', () => {
    const config = loadZooidConfig(
      YAML('announce:\n  human_thread_completion: true\n  owner_mxid: "@mario:mariocake.de"'),
    )
    expect(config.announce).toEqual({
      human_thread_completion: true,
      owner_mxid: '@mario:mariocake.de',
    })
  })

  it('accepts a partial block without inventing the other key', () => {
    const config = loadZooidConfig(YAML('announce:\n  human_thread_completion: true'))
    expect(config.announce).toEqual({ human_thread_completion: true })
    expect(config.announce?.owner_mxid).toBeUndefined()
  })

  it('rejects a non-boolean flag', () => {
    expect(() =>
      loadZooidConfig(YAML('announce:\n  human_thread_completion: "yes"')),
    ).toThrow(/announce\.human_thread_completion must be a boolean/)
  })

  it('rejects a non-MXID owner', () => {
    expect(() => loadZooidConfig(YAML('announce:\n  owner_mxid: "mario"'))).toThrow(
      /announce\.owner_mxid must be a full MXID/,
    )
  })
})

describe('per-agent announce override', () => {
  it('parses a per-agent human_thread_completion override', () => {
    const config = loadZooidConfig(YAML('    announce:\n      human_thread_completion: false'))
    expect(config.agents.qa!.announce).toEqual({ human_thread_completion: false })
  })

  it('is absent when the agent does not override', () => {
    const config = loadZooidConfig(YAML(''))
    expect(config.agents.qa!.announce).toBeUndefined()
  })

  it('does not accept owner_mxid at the agent level (workforce-only field)', () => {
    const config = loadZooidConfig(
      YAML('    announce:\n      owner_mxid: "@mario:mariocake.de"'),
    )
    // The parser ignores owner_mxid per-agent rather than threading a second
    // source of truth; the workforce layer owns it.
    expect(config.agents.qa!.announce).toBeUndefined()
  })

  it('rejects a non-boolean per-agent flag', () => {
    expect(() =>
      loadZooidConfig(YAML('    announce:\n      human_thread_completion: 1')),
    ).toThrow(/agents\.qa\.announce\.human_thread_completion must be a boolean/)
  })
})
