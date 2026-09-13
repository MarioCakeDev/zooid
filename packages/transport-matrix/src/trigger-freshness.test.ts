import { describe, it, expect } from 'vitest'
import { isExpiredTrigger } from './trigger-freshness.js'

const evt = (stamp: Record<string, unknown> | undefined) => ({
  type: 'm.room.message',
  content: { msgtype: 'm.text', body: 'Morning standup.', ...(stamp ? { 'dev.zooid.trigger': stamp } : {}) },
})

describe('isExpiredTrigger', () => {
  const now = 1_000_000_000_000

  it('drops a trigger message older than its ttl', () => {
    expect(isExpiredTrigger(evt({ name: 'standup', fired_at: now - 7 * 3600_000, ttl_ms: 6 * 3600_000 }), now)).toBe(true)
  })

  it('keeps a trigger message inside its ttl', () => {
    expect(isExpiredTrigger(evt({ name: 'standup', fired_at: now - 3600_000, ttl_ms: 6 * 3600_000 }), now)).toBe(false)
  })

  it('keeps a trigger message with no ttl (webhook default)', () => {
    expect(isExpiredTrigger(evt({ name: 'triage', fired_at: now - 30 * 86400_000 }), now)).toBe(false)
  })

  it('never expires an ordinary human message', () => {
    expect(isExpiredTrigger(evt(undefined), now)).toBe(false)
  })

  it('keeps a message whose stamp is malformed rather than dropping it', () => {
    expect(isExpiredTrigger(evt({ name: 'standup', fired_at: 'nope', ttl_ms: 1 }), now)).toBe(false)
  })
})
