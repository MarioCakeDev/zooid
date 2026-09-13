import { describe, it, expect, vi } from 'vitest'
import { startTriggerScheduler } from '../src/daemon/trigger-scheduler.js'

describe('cross-workstation trigger', () => {
  it('fires at an MXID target with no matching local agent', async () => {
    // croner reads a bare schedule against the host's local timezone. Pin it
    // to UTC for this test so the 09:00 firing time is deterministic
    // regardless of where this suite runs — the schedule itself is unrelated
    // to what this cycle changes.
    const prevTz = process.env.TZ
    process.env.TZ = 'UTC'
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-14T08:59:59Z'))
    const sendMessage = vi.fn(async () => ({ event_id: '$1' }))

    const handle = startTriggerScheduler({
      triggers: {
        standup: {
          schedule: '0 9 * * *',
          as: '@cloud.cron:zooid.zoon.eco',
          messages: [{
            room: '#product:zooid.zoon.eco',
            mention: '@ori-macbook.cpo:zooid.zoon.eco',
            text: 'Morning standup.',
          }],
        },
      },
      agentUserIds: { scout: '@cloud.scout:zooid.zoon.eco' }, // note: no cpo
      resolveRoom: async () => '!product:zooid.zoon.eco',
      ensureBot: async () => {},
      sendMessage,
    })

    await vi.advanceTimersByTimeAsync(2000)
    await handle.stop()
    vi.useRealTimers()
    process.env.TZ = prevTz

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0]![0].content['m.mentions'].user_ids)
      .toEqual(['@ori-macbook.cpo:zooid.zoon.eco'])
  })
})
