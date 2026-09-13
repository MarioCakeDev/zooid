import { describe, it, expect, vi } from 'vitest'
import { fireTrigger } from './trigger-runner.js'

const deps = (mention: string, agentUserIds: Record<string, string>) => {
  const sendMessage = vi.fn(async () => ({ event_id: '$1' }))
  return {
    sendMessage,
    call: () =>
      fireTrigger({
        name: 'standup',
        as: '@cloud.cron:zooid.zoon.eco',
        message: { room: '#product:zooid.zoon.eco', mention, text: 'Morning standup.' },
        agentUserIds,
        resolveRoom: async () => '!room:zooid.zoon.eco',
        ensureBot: async () => {},
        sendMessage,
      }),
  }
}

describe('fireTrigger addressing', () => {
  it('uses an MXID mention verbatim, with no local lookup', async () => {
    const { call, sendMessage } = deps('@ori-macbook.cpo:zooid.zoon.eco', {})
    await call()
    expect(sendMessage.mock.calls[0]![0].content['m.mentions']).toEqual({
      user_ids: ['@ori-macbook.cpo:zooid.zoon.eco'],
    })
  })

  it('resolves a bare name through the local agent map', async () => {
    const { call, sendMessage } = deps('scout', { scout: '@cloud.scout:zooid.zoon.eco' })
    await call()
    expect(sendMessage.mock.calls[0]![0].content['m.mentions']).toEqual({
      user_ids: ['@cloud.scout:zooid.zoon.eco'],
    })
  })

  it('stamps dev.zooid.trigger with the trigger name and firing time', async () => {
    const { call, sendMessage } = deps('@ori-macbook.cpo:zooid.zoon.eco', {})
    const before = Date.now()
    await call()
    const stamp = sendMessage.mock.calls[0]![0].content['dev.zooid.trigger'] as {
      name: string
      fired_at: number
      ttl_ms?: number
    }
    expect(stamp.name).toBe('standup')
    expect(stamp.fired_at).toBeGreaterThanOrEqual(before)
  })

  it('skips a bare name with no local binding rather than posting', async () => {
    const { call, sendMessage } = deps('scout', {})
    await call()
    expect(sendMessage).not.toHaveBeenCalled()
  })
})

describe('fireTrigger mention rendering', () => {
  it('leads the body with the MXID so the room can see who was addressed', async () => {
    const { call, sendMessage } = deps('@ori-macbook.cpo:zooid.zoon.eco', {})
    await call()
    expect(sendMessage.mock.calls[0]![0].content.body).toBe(
      '@ori-macbook.cpo:zooid.zoon.eco Morning standup.',
    )
  })

  it('sends no HTML — the client pills a bare MXID, and markup would need escaping', async () => {
    const { call, sendMessage } = deps('@ori-macbook.cpo:zooid.zoon.eco', {})
    await call()
    const c = sendMessage.mock.calls[0]![0].content
    expect(c.format).toBeUndefined()
    expect(c.formatted_body).toBeUndefined()
  })

  it('warns when the addressed user is not in the room', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sendMessage = vi.fn(async () => ({ event_id: '$1' }))
    await fireTrigger({
      name: 'standup',
      as: '@cloud.cron:zooid.zoon.eco',
      message: {
        room: '#product:zooid.zoon.eco',
        mention: '@ori-macbook.cpo:zooid.zoon.eco',
        text: 'Morning standup.',
      },
      agentUserIds: {},
      resolveRoom: async () => '!p:zooid.zoon.eco',
      ensureBot: async () => {},
      sendMessage,
      getJoinedMembers: async () => ({ joined: { '@cloud.product:zooid.zoon.eco': {} } }),
    })
    // posted anyway — the agent may join before it expires
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not in .*#product/))
    warn.mockRestore()
  })

  it('warns only once across repeated fires at the same absent target', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const getJoinedMembers = vi.fn(async () => ({ joined: {} }))
    // A distinct trigger name from the previous test: `warnedTargets` is
    // module-level (dedup lasts the daemon's process lifetime, per spec), so
    // reusing "standup" here would find the key already warned and this
    // test's own two calls would produce zero fresh warnings.
    const fire = () =>
      fireTrigger({
        name: 'standup-repeat',
        as: '@cloud.cron:zooid.zoon.eco',
        message: {
          room: '#product:zooid.zoon.eco',
          mention: '@ori-macbook.cpo:zooid.zoon.eco',
          text: 'Morning standup.',
        },
        agentUserIds: {},
        resolveRoom: async () => '!p:zooid.zoon.eco',
        ensureBot: async () => {},
        sendMessage: async () => ({ event_id: '$1' }),
        getJoinedMembers,
      })
    await fire()
    await fire()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('leaves interpolated webhook text verbatim in the body', async () => {
    const sendMessage = vi.fn(async () => ({ event_id: '$1' }))
    await fireTrigger({
      name: 'triage',
      as: '@cloud.hook:zooid.zoon.eco',
      message: {
        room: '#product:zooid.zoon.eco',
        mention: '@cloud.product:zooid.zoon.eco',
        text: 'Triage "<img src=x> & more".',
      },
      agentUserIds: {},
      resolveRoom: async () => '!r:zooid.zoon.eco',
      ensureBot: async () => {},
      sendMessage,
    })
    const c = sendMessage.mock.calls[0]![0].content
    expect(c.body).toBe('@cloud.product:zooid.zoon.eco Triage "<img src=x> & more".')
    expect(c.formatted_body).toBeUndefined()
  })
})
