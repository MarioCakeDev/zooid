import { describe, it, expect, vi } from 'vitest'
import { MatrixContextProvider } from './context-provider.js'
import type { MatrixClient } from './matrix-client.js'

function fakeClient(overrides: Partial<MatrixClient> = {}): MatrixClient {
  return {
    fetchRoomMessages: vi.fn(),
    getJoinedMembers: vi.fn(),
    fetchRoomName: vi.fn(),
    fetchEvent: vi.fn(),
    fetchThreadRelations: vi.fn(),
    resolveAlias: vi.fn(),
    ...overrides,
  } as unknown as MatrixClient
}

describe('MatrixContextProvider', () => {
  it('maps Matrix m.room.message events into Message[] oldest-first', async () => {
    const client = fakeClient({
      fetchRoomMessages: vi.fn().mockResolvedValue({
        chunk: [
          {
            event_id: '$e2',
            sender: '@bob:hs',
            origin_server_ts: 2000,
            type: 'm.room.message',
            content: { msgtype: 'm.text', body: 'second' },
          },
          {
            event_id: '$e1',
            sender: '@alice:hs',
            origin_server_ts: 1000,
            type: 'm.room.message',
            content: { msgtype: 'm.text', body: 'first' },
          },
        ],
        end: 'matrix-pagination-token',
      }),
    } as unknown as Partial<MatrixClient>)
    const provider = new MatrixContextProvider({
      client,
      asUserId: '@_zooid:hs',
      agentBots: new Map([['@architect:hs', 'architect']]),
    })

    const page = await provider.getRoomHistory('!room:hs', { limit: 50 })

    expect(page.messages.map((m) => m.id)).toEqual(['$e1', '$e2'])
    expect(page.messages[0].sender).toBe('@alice:hs')
    expect(page.messages[0].is_agent).toBe(false)
    expect(page.next_before).toBe('matrix-pagination-token')
    expect(page.has_more).toBe(true)
  })

  it('flags messages from registered agent bots as is_agent + agent_name', async () => {
    const client = fakeClient({
      fetchRoomMessages: vi.fn().mockResolvedValue({
        chunk: [
          {
            event_id: '$e1',
            sender: '@architect:hs',
            origin_server_ts: 1000,
            type: 'm.room.message',
            content: { msgtype: 'm.text', body: 'thinking...' },
          },
        ],
        end: undefined,
      }),
    } as unknown as Partial<MatrixClient>)
    const provider = new MatrixContextProvider({
      client,
      asUserId: '@_zooid:hs',
      agentBots: new Map([['@architect:hs', 'architect']]),
    })
    const page = await provider.getRoomHistory('!room:hs', {})
    expect(page.messages[0]).toMatchObject({
      sender: '@architect:hs',
      is_agent: true,
      agent_name: 'architect',
    })
    expect(page.has_more).toBe(false)
  })

  it('surfaces thread_id on messages that belong to a thread', async () => {
    const client = fakeClient({
      fetchRoomMessages: vi.fn().mockResolvedValue({
        chunk: [
          {
            event_id: '$reply',
            sender: '@alice:hs',
            origin_server_ts: 2000,
            type: 'm.room.message',
            content: {
              msgtype: 'm.text',
              body: 'in-thread reply',
              'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
            },
          },
          {
            event_id: '$top',
            sender: '@bob:hs',
            origin_server_ts: 1000,
            type: 'm.room.message',
            content: { msgtype: 'm.text', body: 'top-level' },
          },
        ],
        end: undefined,
      }),
    } as unknown as Partial<MatrixClient>)
    const provider = new MatrixContextProvider({
      client,
      asUserId: '@_zooid:hs',
      agentBots: new Map(),
    })
    const page = await provider.getRoomHistory('!room:hs', {})
    const byId = new Map(page.messages.map((m) => [m.id, m]))
    expect(byId.get('$reply')?.thread_id).toBe('$root')
    expect(byId.get('$top')?.thread_id).toBeUndefined()
  })

  it('passes channelId and pagination opts through to the matrix client without thread filtering', async () => {
    const fetchRoomMessages = vi.fn().mockResolvedValue({ chunk: [], end: undefined })
    const provider = new MatrixContextProvider({
      client: fakeClient({ fetchRoomMessages } as unknown as Partial<MatrixClient>),
      asUserId: '@_zooid:hs',
      agentBots: new Map(),
    })
    await provider.getRoomHistory('!room:hs', { limit: 25, before: 'cursor-1' })
    expect(fetchRoomMessages).toHaveBeenCalledWith({
      roomId: '!room:hs',
      asUserId: '@_zooid:hs',
      limit: 25,
      from: 'cursor-1',
      filter: { types: ['m.room.message'] },
    })
  })

  it('getChannelMembers returns joined members with is_agent flags', async () => {
    const client = fakeClient({
      getJoinedMembers: vi.fn().mockResolvedValue({
        joined: {
          '@alice:hs': { display_name: 'Alice' },
          '@architect:hs': { display_name: 'architect' },
        },
      }),
    } as unknown as Partial<MatrixClient>)
    const provider = new MatrixContextProvider({
      client,
      asUserId: '@_zooid:hs',
      agentBots: new Map([['@architect:hs', 'architect']]),
    })
    const members = await provider.getChannelMembers('!room:hs')
    expect(members).toEqual([
      { id: '@alice:hs', name: 'Alice', is_agent: false },
      { id: '@architect:hs', name: 'architect', is_agent: true, agent_name: 'architect' },
    ])
  })

  it('getRoomInfo returns the room name and transport: matrix', async () => {
    const client = fakeClient({
      fetchRoomName: vi.fn().mockResolvedValue('engineering'),
    } as unknown as Partial<MatrixClient>)
    const provider = new MatrixContextProvider({
      client,
      asUserId: '@_zooid:hs',
      agentBots: new Map(),
    })
    const info = await provider.getRoomInfo('!room:hs')
    expect(info).toEqual({ id: '!room:hs', name: 'engineering', transport: 'matrix' })
  })

  it('getRooms maps this agent\'s own room bindings to RoomInfo, fetching each name', async () => {
    const fetchRoomName = vi.fn().mockResolvedValueOnce('general').mockResolvedValueOnce('dev')
    const client = fakeClient({ fetchRoomName } as unknown as Partial<MatrixClient>)
    const provider = new MatrixContextProvider({
      client,
      asUserId: '@architect:hs',
      agentBots: new Map(),
      rooms: [{ alias: '!a:hs' }, { alias: '!b:hs' }],
    })
    const rooms = await provider.getRooms()
    expect(rooms).toEqual([
      { id: '!a:hs', name: 'general', transport: 'matrix' },
      { id: '!b:hs', name: 'dev', transport: 'matrix' },
    ])
    expect(fetchRoomName).toHaveBeenCalledWith('!a:hs', '@architect:hs')
  })

  it('getRooms returns an empty list when the provider has no room bindings', async () => {
    const provider = new MatrixContextProvider({
      client: fakeClient(),
      asUserId: '@architect:hs',
      agentBots: new Map(),
    })
    expect(await provider.getRooms()).toEqual([])
  })

  it('sendMessage posts as this agent into a bound room, echoing thread_id when replying in-thread', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ event_id: '$sent' })
    const fetchEvent = vi.fn().mockResolvedValue({ event_id: '$root' })
    const client = fakeClient({ sendMessage, fetchEvent } as unknown as Partial<MatrixClient>)
    const provider = new MatrixContextProvider({
      client,
      asUserId: '@architect:hs',
      agentBots: new Map(),
      rooms: [{ alias: '!a:hs' }],
    })
    const result = await provider.sendMessage({ room: '!a:hs', thread_id: '$root', text: 'noted' })
    expect(result).toEqual({ event_id: '$sent', thread_id: '$root' })
    expect(sendMessage).toHaveBeenCalledWith({
      roomId: '!a:hs',
      asUserId: '@architect:hs',
      content: { msgtype: 'm.notice', body: 'noted' },
      threadRoot: '$root',
    })
  })

  it('sendMessage resolves an alias/bare room name to the bound canonical room id', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ event_id: '$sent' })
    const resolveAlias = vi.fn().mockResolvedValue('!review:hs')
    const provider = new MatrixContextProvider({
      client: fakeClient({ sendMessage, resolveAlias } as unknown as Partial<MatrixClient>),
      asUserId: '@architect:hs',
      agentBots: new Map(),
      rooms: [{ alias: '!review:hs' }],
    })
    const result = await provider.sendMessage({ room: '#review', text: 'noted' })
    expect(result).toEqual({ event_id: '$sent' })
    expect(resolveAlias).toHaveBeenCalledWith('#review:hs')
    expect(sendMessage).toHaveBeenCalledWith({
      roomId: '!review:hs',
      asUserId: '@architect:hs',
      content: { msgtype: 'm.notice', body: 'noted' },
    })
  })

  it('sendMessage resolves a display name from getRooms to the bound canonical room id', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ event_id: '$sent' })
    const resolveAlias = vi.fn().mockResolvedValue(null)
    const fetchRoomName = vi.fn().mockResolvedValue('review')
    const provider = new MatrixContextProvider({
      client: fakeClient({ sendMessage, resolveAlias, fetchRoomName } as unknown as Partial<MatrixClient>),
      asUserId: '@architect:hs',
      agentBots: new Map(),
      rooms: [{ alias: '!review:hs' }],
    })
    const result = await provider.sendMessage({ room: 'review', text: 'noted' })
    expect(result).toEqual({ event_id: '$sent' })
    expect(sendMessage).toHaveBeenCalledWith({
      roomId: '!review:hs',
      asUserId: '@architect:hs',
      content: { msgtype: 'm.notice', body: 'noted' },
    })
  })

  it('sendMessage falls back to a display name for #name:server without a directory alias', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ event_id: '$sent' })
    const resolveAlias = vi.fn().mockResolvedValue(null) // no #handoffs:mariocake.de alias
    const fetchRoomName = vi.fn().mockResolvedValue('handoffs')
    const provider = new MatrixContextProvider({
      client: fakeClient({ sendMessage, resolveAlias, fetchRoomName } as unknown as Partial<MatrixClient>),
      asUserId: '@architect:hs',
      agentBots: new Map(),
      rooms: [{ alias: '!handoffs:hs' }],
    })
    const result = await provider.sendMessage({ room: '#handoffs:mariocake.de', text: 'noted' })
    expect(result).toEqual({ event_id: '$sent' })
    expect(resolveAlias).toHaveBeenCalledWith('#handoffs:mariocake.de')
    expect(sendMessage).toHaveBeenCalledWith({
      roomId: '!handoffs:hs',
      asUserId: '@architect:hs',
      content: { msgtype: 'm.notice', body: 'noted' },
    })
  })

  it('sendMessage refuses an ambiguous display name instead of guessing a room', async () => {
    const provider = new MatrixContextProvider({
      client: fakeClient({
        resolveAlias: vi.fn().mockResolvedValue(null),
        fetchRoomName: vi.fn().mockResolvedValue('general'),
      } as unknown as Partial<MatrixClient>),
      asUserId: '@architect:hs',
      agentBots: new Map(),
      rooms: [{ alias: '!a:hs' }, { alias: '!b:hs' }],
    })
    await expect(provider.sendMessage({ room: 'general', text: 'hi' })).rejects.toThrow(
      /ambiguous_room/,
    )
  })

  it('sendMessage refuses an alias resolving to an unbound room without falling through to a name match', async () => {
    const fetchRoomName = vi.fn().mockResolvedValue('general')
    const provider = new MatrixContextProvider({
      client: fakeClient({
        resolveAlias: vi.fn().mockResolvedValue('!general:otherserver'),
        fetchRoomName,
      } as unknown as Partial<MatrixClient>),
      asUserId: '@architect:hs',
      agentBots: new Map(),
      rooms: [{ alias: '!local-general:hs' }],
    })
    await expect(
      provider.sendMessage({ room: '#general:otherserver', text: 'hi' }),
    ).rejects.toThrow(/not_in_room/)
    expect(fetchRoomName).not.toHaveBeenCalled()
  })

  it('sendMessage propagates a directory failure instead of reporting not_in_room', async () => {
    const provider = new MatrixContextProvider({
      client: fakeClient({
        resolveAlias: vi.fn().mockRejectedValue(new Error('resolveAlias(#review:hs) failed: 500')),
      } as unknown as Partial<MatrixClient>),
      asUserId: '@architect:hs',
      agentBots: new Map(),
      rooms: [{ alias: '!review:hs' }],
    })
    await expect(provider.sendMessage({ room: '#review', text: 'hi' })).rejects.toThrow('500')
  })

  it('sendMessage falls back to top-level when thread_id belongs to another room', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ event_id: '$sent' })
    const fetchEvent = vi.fn().mockResolvedValue(null) // root not in this room
    const provider = new MatrixContextProvider({
      client: fakeClient({ sendMessage, fetchEvent } as unknown as Partial<MatrixClient>),
      asUserId: '@architect:hs',
      agentBots: new Map(),
      rooms: [{ alias: '!review:hs' }],
    })
    const result = await provider.sendMessage({
      room: '!review:hs',
      thread_id: '$root-in-handoffs',
      text: 'noted',
    })
    expect(sendMessage).toHaveBeenCalledWith({
      roomId: '!review:hs',
      asUserId: '@architect:hs',
      content: { msgtype: 'm.notice', body: 'noted' },
    })
    expect(result).toMatchObject({ event_id: '$sent', warning: expect.stringContaining('top-level') })
    expect(result.thread_id).toBeUndefined()
  })

  it('sendMessage falls back to top-level when the homeserver rejects a cross-room relation', async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(
          new Error('sendEvent(m.room.message) failed: 400 {"errcode":"M_INVALID_PARAM"} Relations must be in the same room'),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce({ event_id: '$sent' })
    // Probe errors (undefined verdict) leave the relation in place, so the send
    // is what surfaces the mismatch — and the retry must drop it.
    const fetchEvent = vi.fn().mockRejectedValue(new Error('probe failed'))
    const provider = new MatrixContextProvider({
      client: fakeClient({ sendMessage, fetchEvent } as unknown as Partial<MatrixClient>),
      asUserId: '@architect:hs',
      agentBots: new Map(),
      rooms: [{ alias: '!review:hs' }],
    })
    const result = await provider.sendMessage({
      room: '!review:hs',
      thread_id: '$root-in-handoffs',
      text: 'noted',
    })
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(sendMessage.mock.calls[1][0]).not.toHaveProperty('threadRoot')
    expect(result).toMatchObject({ event_id: '$sent', warning: expect.stringContaining('top-level') })
  })

  it('sendMessage refuses a room this agent is not bound to', async () => {
    const provider = new MatrixContextProvider({
      client: fakeClient(),
      asUserId: '@architect:hs',
      agentBots: new Map(),
      rooms: [{ alias: '!a:hs' }],
    })
    await expect(provider.sendMessage({ room: '!elsewhere:hs', text: 'hi' })).rejects.toThrow(
      /not_in_room/,
    )
  })

  it('getRecentThreads returns top-level entries newest-first with bundled thread metadata, skipping thread replies', async () => {
    const client = fakeClient({
      fetchRoomMessages: vi.fn().mockResolvedValue({
        chunk: [
          {
            event_id: '$top2',
            sender: '@bob:hs',
            origin_server_ts: 3000,
            type: 'm.room.message',
            content: { msgtype: 'm.text', body: 'standalone' },
          },
          {
            event_id: '$reply1',
            sender: '@alice:hs',
            origin_server_ts: 2500,
            type: 'm.room.message',
            content: {
              msgtype: 'm.text',
              body: 'in-thread',
              'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
            },
          },
          {
            event_id: '$root',
            sender: '@alice:hs',
            origin_server_ts: 1000,
            type: 'm.room.message',
            content: { msgtype: 'm.text', body: 'thread root' },
            unsigned: {
              'm.relations': {
                'm.thread': { count: 3, latest_event: { origin_server_ts: 2500 } },
              },
            },
          },
        ],
        end: 'next-page',
      }),
    } as unknown as Partial<MatrixClient>)
    const provider = new MatrixContextProvider({
      client,
      asUserId: '@_zooid:hs',
      agentBots: new Map(),
    })
    const page = await provider.getRecentThreads('!room:hs', { limit: 50 })
    expect(page.threads.map((t) => t.id)).toEqual(['$top2', '$root'])
    expect(page.threads[0]).toMatchObject({
      id: '$top2',
      reply_count: 0,
      last_activity_at: new Date(3000).toISOString(),
    })
    expect(page.threads[1]).toMatchObject({
      id: '$root',
      reply_count: 3,
      last_activity_at: new Date(2500).toISOString(),
    })
    expect(page.has_more).toBe(true)
    expect(page.next_before).toBe('next-page')
  })

  it('getThreadHistory prepends the root event then appends replies oldest-first', async () => {
    const client = fakeClient({
      fetchEvent: vi.fn().mockResolvedValue({
        event_id: '$root',
        sender: '@alice:hs',
        origin_server_ts: 1000,
        type: 'm.room.message',
        content: { msgtype: 'm.text', body: 'root msg' },
      }),
      fetchThreadRelations: vi.fn().mockResolvedValue({
        chunk: [
          {
            event_id: '$r1',
            sender: '@bob:hs',
            origin_server_ts: 1500,
            type: 'm.room.message',
            content: {
              msgtype: 'm.text',
              body: 'first reply',
              'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
            },
          },
          {
            event_id: '$r2',
            sender: '@alice:hs',
            origin_server_ts: 2000,
            type: 'm.room.message',
            content: {
              msgtype: 'm.text',
              body: 'second reply',
              'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
            },
          },
        ],
        next_batch: undefined,
      }),
    } as unknown as Partial<MatrixClient>)
    const provider = new MatrixContextProvider({
      client,
      asUserId: '@_zooid:hs',
      agentBots: new Map(),
    })
    const page = await provider.getThreadHistory('!room:hs', '$root', {})
    expect(page.messages.map((m) => m.id)).toEqual(['$root', '$r1', '$r2'])
    expect(page.messages.every((m) => m.thread_id === '$root')).toBe(true)
    expect(page.has_more).toBe(false)
  })

  it('getThreadHistory skips the root fetch when paginating (before is set)', async () => {
    const fetchEvent = vi.fn()
    const fetchThreadRelations = vi.fn().mockResolvedValue({
      chunk: [],
      next_batch: 'next-cursor',
    })
    const provider = new MatrixContextProvider({
      client: fakeClient({ fetchEvent, fetchThreadRelations } as unknown as Partial<MatrixClient>),
      asUserId: '@_zooid:hs',
      agentBots: new Map(),
    })
    const page = await provider.getThreadHistory('!room:hs', '$root', {
      limit: 50,
      before: 'cursor-1',
    })
    expect(fetchEvent).not.toHaveBeenCalled()
    expect(fetchThreadRelations).toHaveBeenCalledWith({
      roomId: '!room:hs',
      rootEventId: '$root',
      asUserId: '@_zooid:hs',
      limit: 50,
      from: 'cursor-1',
    })
    expect(page.next_before).toBe('next-cursor')
    expect(page.has_more).toBe(true)
  })

  it('falls back to the room id when no name state is set', async () => {
    const client = fakeClient({
      fetchRoomName: vi.fn().mockResolvedValue(null),
    } as unknown as Partial<MatrixClient>)
    const provider = new MatrixContextProvider({
      client,
      asUserId: '@_zooid:hs',
      agentBots: new Map(),
    })
    const info = await provider.getRoomInfo('!room:hs')
    expect(info.name).toBe('!room:hs')
  })

  it('renders media events as placeholders instead of skipping them', async () => {
    const client = fakeClient({
      fetchRoomMessages: vi.fn().mockResolvedValue({
        chunk: [
          {
            event_id: '$img',
            sender: '@alice:hs',
            origin_server_ts: 1000,
            type: 'm.room.message',
            content: { msgtype: 'm.image', body: 'dog.jpg', url: 'mxc://hs/a' },
          },
          {
            event_id: '$file',
            sender: '@alice:hs',
            origin_server_ts: 2000,
            type: 'm.room.message',
            content: { msgtype: 'm.file', body: 'report.pdf', url: 'mxc://hs/b' },
          },
        ],
        end: undefined,
      }),
    } as unknown as Partial<MatrixClient>)
    const provider = new MatrixContextProvider({
      client,
      asUserId: '@_zooid:hs',
      agentBots: new Map(),
    })
    const page = await provider.getRoomHistory('!room:hs', {})
    const byId = new Map(page.messages.map((m) => [m.id, m]))
    expect(byId.get('$img')?.text).toBe('[image: dog.jpg]')
    expect(byId.get('$file')?.text).toBe('[file: report.pdf]')
  })

  it('renders agent prose sent as m.notice — ZNC025 §10 switches agent output to m.notice', async () => {
    const client = fakeClient({
      fetchRoomMessages: vi.fn().mockResolvedValue({
        chunk: [
          {
            event_id: '$e1',
            sender: '@architect:hs',
            origin_server_ts: 1000,
            type: 'm.room.message',
            content: { msgtype: 'm.notice', body: 'agent output' },
          },
        ],
        end: undefined,
      }),
    } as unknown as Partial<MatrixClient>)
    const provider = new MatrixContextProvider({
      client,
      asUserId: '@_zooid:hs',
      agentBots: new Map([['@architect:hs', 'architect']]),
    })
    const page = await provider.getRoomHistory('!room:hs', {})
    expect(page.messages[0]?.text).toBe('agent output')
  })

  it('getRecentThreads keeps a thread rooted in an m.notice', async () => {
    const client = fakeClient({
      fetchRoomMessages: vi.fn().mockResolvedValue({
        chunk: [
          {
            event_id: '$root',
            sender: '@architect:hs',
            origin_server_ts: 1000,
            type: 'm.room.message',
            content: { msgtype: 'm.notice', body: 'agent thread root' },
          },
        ],
        end: undefined,
      }),
    } as unknown as Partial<MatrixClient>)
    const provider = new MatrixContextProvider({
      client,
      asUserId: '@_zooid:hs',
      agentBots: new Map([['@architect:hs', 'architect']]),
    })
    const page = await provider.getRecentThreads('!room:hs', { limit: 50 })
    expect(page.threads.map((t) => t.id)).toEqual(['$root'])
    expect(page.threads[0]?.text).toBe('agent thread root')
  })
})

// The authorization boundary for context reads is the homeserver, not this
// class: every read is impersonated as the *agent's own* Matrix user, so a room
// or thread the agent isn't in fails at Matrix. Nothing asserted that, and a
// stale doc comment claimed the opposite (that asUserId was the AS bot, which
// can read every room) — so a refactor could have quietly swapped in the AS
// user and turned a homeserver-enforced boundary into an honour system.
describe('MatrixContextProvider — reads are impersonated as the agent', () => {
  const AGENT = '@dev.assistant:hs'

  function provider(overrides: Partial<MatrixClient>) {
    return new MatrixContextProvider({
      client: fakeClient(overrides),
      asUserId: AGENT,
      agentBots: new Map(),
    })
  }

  it('threads the agent user through every read, never a different user', async () => {
    const fetchRoomMessages = vi.fn().mockResolvedValue({ chunk: [], end: undefined })
    const getJoinedMembers = vi.fn().mockResolvedValue({ joined: {} })
    const fetchRoomName = vi.fn().mockResolvedValue('room')
    const fetchEvent = vi.fn().mockResolvedValue(null)
    const fetchThreadRelations = vi.fn().mockResolvedValue({ chunk: [], next_batch: undefined })
    const p = provider({
      fetchRoomMessages,
      getJoinedMembers,
      fetchRoomName,
      fetchEvent,
      fetchThreadRelations,
    } as unknown as Partial<MatrixClient>)

    await p.getRoomHistory('!room:hs', { limit: 10 })
    await p.getRecentThreads('!room:hs', { limit: 10 })
    await p.getThreadHistory('!room:hs', '$root', { limit: 10 })
    await p.getChannelMembers('!room:hs')
    await p.getRoomInfo('!room:hs')

    expect(fetchRoomMessages.mock.calls.every(([a]) => a.asUserId === AGENT)).toBe(true)
    expect(fetchThreadRelations).toHaveBeenCalledWith(expect.objectContaining({ asUserId: AGENT }))
    // These two take the user as a positional argument, not a field.
    expect(getJoinedMembers).toHaveBeenCalledWith('!room:hs', AGENT)
    expect(fetchRoomName).toHaveBeenCalledWith('!room:hs', AGENT)
    expect(fetchEvent).toHaveBeenCalledWith('!room:hs', '$root', AGENT)
  })

  // An agent naming a room it isn't in must fail loudly. Swallowing the error
  // and returning `{ messages: [] }` would read as "empty room" to the model —
  // indistinguishable from a real empty room, and it would hide the refusal.
  it('propagates a homeserver refusal instead of returning an empty page', async () => {
    const forbidden = new Error('fetchRoomMessages(!private:hs) failed: 403')
    const p = provider({
      fetchRoomMessages: vi.fn().mockRejectedValue(forbidden),
    } as unknown as Partial<MatrixClient>)

    await expect(p.getRoomHistory('!private:hs', { limit: 10 })).rejects.toThrow('403')
  })

  it('propagates a refusal on the thread path too', async () => {
    const p = provider({
      fetchEvent: vi.fn().mockResolvedValue(null),
      fetchThreadRelations: vi
        .fn()
        .mockRejectedValue(new Error('fetchThreadRelations($x) failed: 403')),
    } as unknown as Partial<MatrixClient>)

    await expect(p.getThreadHistory('!private:hs', '$x', { limit: 10 })).rejects.toThrow('403')
  })
})
