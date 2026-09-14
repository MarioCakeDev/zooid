import { describe, it, expect } from 'vitest'
import { loadZooidConfig } from './config.js'

const base = `
runtime: local
workstation: cloud
transports:
  matrix:
    type: matrix
    homeserver: http://localhost:8449
    as_token: t
    hs_token: h
    user_namespace: '@cloud\\..*:zooid.zoon.eco'
agents:
  scout:
    acp: { preset: opencode }
    matrix:
      display_name: Scout
      rooms: ["#scout"]
      trigger: mention
`

const withTrigger = (mention: string) => `${base}
triggers:
  standup:
    schedule: "0 9 * * 1-5"
    as: "@cloud.cron:zooid.zoon.eco"
    room: "#product:zooid.zoon.eco"
    mention: "${mention}"
    text: "Morning standup."
`

describe('triggers.<name>.mention as a full MXID', () => {
  it('accepts an MXID that is not a local agent', () => {
    const cfg = loadZooidConfig(withTrigger('@ori-macbook.cpo:zooid.zoon.eco'))
    expect(cfg.triggers['standup']!.messages[0]!.mention).toBe('@ori-macbook.cpo:zooid.zoon.eco')
  })

  it('still accepts a bare local agent name', () => {
    const cfg = loadZooidConfig(withTrigger('scout'))
    expect(cfg.triggers['standup']!.messages[0]!.mention).toBe('scout')
  })

  it('rejects an MXID on a different homeserver', () => {
    expect(() => loadZooidConfig(withTrigger('@cpo:example.org'))).toThrow(
      /different homeserver/i,
    )
  })

  it('rejects a bare name that is not a local agent', () => {
    expect(() => loadZooidConfig(withTrigger('nobody'))).toThrow(
      /unknown agent "nobody"/,
    )
  })

  it('still rejects a trigger that mentions its own posting identity', () => {
    expect(() => loadZooidConfig(withTrigger('@cloud.cron:zooid.zoon.eco'))).toThrow(
      /must not equal the mentioned agent/,
    )
  })
})
