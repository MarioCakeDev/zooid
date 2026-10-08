import { describe, it, expect } from 'vitest'
import { SpawnRegistry } from './spawn-registry.js'
import type { TransportContextProvider } from '@zooid/core'

const fakeProvider: TransportContextProvider = {
  getRoomHistory: async () => ({ messages: [], has_more: false }),
  getRecentThreads: async () => ({ threads: [], has_more: false }),
  getThreadHistory: async () => ({ messages: [], has_more: false }),
  getChannelMembers: async () => [],
  getRoomInfo: async () => ({ id: 'r', name: 'r', transport: 'matrix' }),
  getRooms: async () => [],
  sendMessage: async () => ({ event_id: '$sent' }),
}

describe('SpawnRegistry', () => {
  it('register() reuses the binding and spawn-id for an existing agent/session key', () => {
    const r = new SpawnRegistry()
    const a = r.register({
      agentName: 'architect',
      threadRef: { channelId: '!room:hs', threadId: '$root' },
      provider: fakeProvider,
    })
    const b = r.register({
      agentName: 'architect',
      threadRef: { channelId: '!room:hs', threadId: '$root' },
      provider: fakeProvider,
    })
    expect(b).toBe(a)
    expect(a).toMatch(/^[a-f0-9-]{36}$/)
  })

  it('register() refreshes the reused binding from the latest input', () => {
    const r = new SpawnRegistry()
    const a = r.register({
      agentName: 'architect',
      threadRef: { channelId: '!room:hs', threadId: '$root' },
      provider: fakeProvider,
    })
    const updated: TransportContextProvider = { ...fakeProvider, sendMessage: async () => ({ event_id: '$updated' }) }
    const b = r.register({
      agentName: 'architect',
      threadRef: { channelId: '!room:hs', threadId: '$root' },
      sessionKey: '$root',
      provider: updated,
    })
    expect(b).toBe(a)
    expect(r.get(a)?.provider).toBe(updated)
  })

  it('register() mints distinct spawn-ids for distinct session keys', () => {
    const r = new SpawnRegistry()
    const a = r.register({
      agentName: 'architect',
      threadRef: { channelId: '!room:hs', threadId: '$root' },
      sessionKey: '$t1',
      provider: fakeProvider,
    })
    const b = r.register({
      agentName: 'architect',
      threadRef: { channelId: '!room:hs', threadId: '$root' },
      sessionKey: '$t2',
      provider: fakeProvider,
    })
    expect(a).not.toEqual(b)
    expect(a).toMatch(/^[a-f0-9-]{36}$/)
    expect(b).toMatch(/^[a-f0-9-]{36}$/)
  })

  it('get() returns the binding stored under the spawn-id', () => {
    const r = new SpawnRegistry()
    const spawnId = r.register({
      agentName: 'architect',
      threadRef: { channelId: '!room:hs', threadId: '$root' },
      provider: fakeProvider,
    })
    const b = r.get(spawnId)
    expect(b?.agentName).toBe('architect')
    expect(b?.threadRef.channelId).toBe('!room:hs')
    expect(b?.provider).toBe(fakeProvider)
  })

  it('release() removes the binding', () => {
    const r = new SpawnRegistry()
    const spawnId = r.register({
      agentName: 'a',
      threadRef: { channelId: 'c', threadId: 't' },
      provider: fakeProvider,
    })
    r.release(spawnId)
    expect(r.get(spawnId)).toBeUndefined()
  })

  it('get() returns undefined for unknown spawn-ids', () => {
    const r = new SpawnRegistry()
    expect(r.get('not-a-real-id')).toBeUndefined()
  })

  it('resolves bindings by ACP session after linking without crossing agents', () => {
    const r = new SpawnRegistry()
    const a = r.register({ agentName: 'a', threadRef: { channelId: 'c', threadId: 't' }, sessionKey: 't', provider: fakeProvider })
    const b = r.register({ agentName: 'b', threadRef: { channelId: 'c', threadId: 't' }, sessionKey: 't', provider: fakeProvider })
    r.linkSession('a', 't', 'acp-a')
    r.linkSession('b', 't', 'acp-b')
    expect(r.getByAcpSession('acp-a')?.spawnId).toBe(a)
    expect(r.getByAcpSession('acp-b')?.spawnId).toBe(b)
    expect(r.getByAcpSession('orphan')).toBeUndefined()
  })
})
