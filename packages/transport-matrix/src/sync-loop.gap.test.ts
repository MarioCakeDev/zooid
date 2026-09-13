import { describe, it, expect, vi } from 'vitest'
import { SyncLoop } from './sync-loop.js'

describe('SyncLoop gap recovery', () => {
  it('pages backwards from prev_batch when the timeline is limited', async () => {
    const seen: string[] = []
    const fetchRoomMessages = vi
      .fn()
      .mockResolvedValueOnce({ chunk: [{ event_id: '$b', content: {} }], end: 'p1' })
      .mockResolvedValueOnce({ chunk: [{ event_id: '$a', content: {} }], end: 'cursor-0' })

    const loop = new SyncLoop({
      client: {
        sync: async () => ({
          next_batch: 'cursor-1',
          rooms: {
            join: {
              '!r:s': {
                timeline: { events: [{ event_id: '$c', content: {} }], limited: true, prev_batch: 'p0' },
              },
            },
          },
        }),
        fetchRoomMessages,
      },
      asUserId: '@ori-macbook.cpo:zooid.zoon.eco',
      loadSince: () => 'cursor-0',
      saveSince: () => {},
      onEvent: (e) => { seen.push(e.event_id as string) },
    })

    await loop.tick()

    // oldest-first after the backward pages are reversed, then the live timeline
    expect(seen).toEqual(['$a', '$b', '$c'])
    expect(fetchRoomMessages).toHaveBeenCalledTimes(2)
  })

  it('does not page when the timeline is not limited', async () => {
    const fetchRoomMessages = vi.fn()
    const loop = new SyncLoop({
      client: {
        sync: async () => ({
          next_batch: 'cursor-1',
          rooms: { join: { '!r:s': { timeline: { events: [{ event_id: '$c', content: {} }] } } } },
        }),
        fetchRoomMessages,
      },
      asUserId: '@a:s',
      loadSince: () => 'cursor-0',
      saveSince: () => {},
      onEvent: () => {},
    })
    await loop.tick()
    expect(fetchRoomMessages).not.toHaveBeenCalled()
  })

  it('stops paging at a bounded page count rather than walking all history', async () => {
    const fetchRoomMessages = vi.fn().mockResolvedValue({ chunk: [{ event_id: '$x', content: {} }], end: 'never-matches' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loop = new SyncLoop({
      client: {
        sync: async () => ({
          next_batch: 'cursor-1',
          rooms: { join: { '!r:s': { timeline: { events: [], limited: true, prev_batch: 'p0' } } } },
        }),
        fetchRoomMessages,
      },
      asUserId: '@a:s',
      loadSince: () => 'cursor-0',
      saveSince: () => {},
      onEvent: () => {},
      maxGapPages: 3,
    })
    await loop.tick()
    expect(fetchRoomMessages).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/gap/i), expect.anything())
    warn.mockRestore()
  })
})
