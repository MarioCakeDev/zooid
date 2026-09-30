import { describe, it, expect } from 'vitest'
import { loadZooidConfig } from './config.js'

/**
 * `agents.<name>.first_response_timeout` bounds how long a prompt may produce
 * nothing at all before the session is declared wedged. It is a per-agent knob
 * on top of the client default, so the interesting cases are: absent (use the
 * default), malformed, and "disabled" — which is refused, because no deadline
 * is precisely the silent-failure configuration this exists to prevent.
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

describe('agents.<name>.first_response_timeout', () => {
  it('is undefined when unset, so the AcpClient default applies', () => {
    const config = loadZooidConfig(YAML(''))
    expect(config.agents.qa!.first_response_timeout_ms).toBeUndefined()
  })

  it('parses a duration string into milliseconds', () => {
    const config = loadZooidConfig(YAML('    first_response_timeout: 45s'))
    expect(config.agents.qa!.first_response_timeout_ms).toBe(45_000)
  })

  it('rejects a malformed duration', () => {
    expect(() => loadZooidConfig(YAML('    first_response_timeout: "soon"'))).toThrow(
      /first_response_timeout: "soon" is not a valid duration/,
    )
  })

  it('refuses 0 — an unbounded silence is the bug, not a configuration', () => {
    expect(() => loadZooidConfig(YAML('    first_response_timeout: 0'))).toThrow(
      /not allowed/,
    )
  })
})
