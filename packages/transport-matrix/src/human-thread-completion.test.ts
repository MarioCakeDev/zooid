import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createMatrixTransport } from './transport.js'
import { matrixEventPermalink, completionSummary } from './event-encoders.js'
import type { AgentBinding } from './router.js'

/**
 * Opt-in human-thread completion notice. When an agent that opted in
 * (`announce.human_thread_completion`) finishes a thread-master turn on a
 * thread rooted by the human owner, it posts exactly one top-level room
 * message (no `threadRoot`, so no thread relation) linking to the thread's
 * latest message. Everything else is silence.
 */

const ROOM = '!r:example.com'
const OWNER = '@mario:example.com'

function fakeRegistry() {
  const reg = {
    hasAgent: vi.fn(() => true),
    ensureSession: vi.fn(
      async (_name: string, threadId: string, _roomId: string) => `sess-${threadId}`,
    ),
    endSession: vi.fn(async () => {}),
    cancelSession: vi.fn(async () => {}),
    prompt: vi.fn(async () => ({ stopReason: 'end_turn' as const })),
    stopAll: vi.fn(async () => {}),
    getApprovalTimeoutMs: vi.fn(() => 0),
    onEvent: vi.fn() as unknown as (n: string, e: unknown) => void,
    onApprovalRequest: vi.fn(async () => ({ decision: 'cancel' as const })),
  }
  return reg
}

function fakeApprovals() {
  const e = new EventEmitter()
  return Object.assign(e, {
    register: vi.fn(),
    resolve: vi.fn(() => true),
    get: vi.fn(() => undefined),
    resolveById: vi.fn(() => true),
    cancelSession: vi.fn(),
    listPending: vi.fn(() => []),
  })
}

function fakeClient(opts: { dropEventIds?: boolean } = {}) {
  let n = 0
  return {
    registerBot: vi.fn(async () => undefined),
    joinRoom: vi.fn(async () => undefined),
    leaveRoom: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => (opts.dropEventIds ? {} : { event_id: `$msg-${++n}` })),
    sendCustomEvent: vi.fn(async () => (opts.dropEventIds ? {} : { event_id: `$custom-${++n}` })),
    fetchEvent: vi.fn(async () => null),
    fetchThreadRelations: vi.fn(async () => ({ chunk: [] })),
    setTyping: vi.fn(async () => {}),
    setPresence: vi.fn(async () => {}),
  }
}

type Client = ReturnType<typeof fakeClient>

const architect: AgentBinding = {
  name: 'architect',
  userId: '@architect:example.com',
  rooms: [{ alias: ROOM }],
  trigger: 'mention',
  announceHumanThreadCompletion: true,
}

const builder: AgentBinding = {
  name: 'builder',
  userId: '@builder:example.com',
  rooms: [{ alias: ROOM }],
  trigger: 'mention',
  announceHumanThreadCompletion: true,
}

/** A catch-all agent, for roots authored by a non-mentioning sender. */
const builderAny: AgentBinding = { ...builder, trigger: 'any' }

interface PendingInput {
  countFor: (sessionKey: string) => number
  cancelFor: (sessionKeys: string[]) => void
}

function makeHarness(
  bindings: AgentBinding[],
  callbacks: {
    prompt?: (name: string, p: { threadId: string }) => Promise<{ stopReason: string }>
    pendingInput?: PendingInput
    dropEventIds?: boolean
    ownerUserId?: string | undefined
  } = {},
) {
  const agents = fakeRegistry()
  const approvals = fakeApprovals()
  const client = fakeClient({ dropEventIds: callbacks.dropEventIds })
  if (callbacks.prompt) agents.prompt.mockImplementation(callbacks.prompt as never)
  const transport = createMatrixTransport({
    agents: agents as never,
    approvals: approvals as never,
    client: client as never,
    bindings,
    hsToken: 'hs-secret',
    botUserId: '@zooid:example.com',
    ownerUserId: callbacks.ownerUserId === undefined ? OWNER : callbacks.ownerUserId,
    triggerUserIds: ['@cron:example.com'],
    serverName: 'example.com',
    drainQuietMs: 0,
    mirrorEditIntervalMs: 0,
    pendingInput: callbacks.pendingInput as never,
  })
  return { transport, agents, client }
}

let txn = 0
function post(transport: ReturnType<typeof makeHarness>['transport'], events: unknown[]) {
  return transport.app.request(`/_matrix/app/v1/transactions/t${++txn}`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer hs-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ events }),
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r))
}

/** Top-level completion notices: no `threadRoot` and the HTML link marker. */
function notices(client: Client) {
  return client.sendMessage.mock.calls
    .map((c) => c[0] as { threadRoot?: string; content?: { formatted_body?: string } })
    .filter((a) => a?.content?.formatted_body?.includes('Open thread') === true)
}

function humanRootEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: 'm.room.message',
    event_id: '$root',
    room_id: ROOM,
    sender: OWNER,
    content: {
      msgtype: 'm.text',
      body: 'architect please',
      'm.mentions': { user_ids: ['@architect:example.com'] },
      ...overrides,
    },
  }
}

/** A prompt that emits one prose chunk so the turn produces output. */
function prose(text: string) {
  return async (name: string, p: { threadId: string }) => {
    harnessRefs.agents.onEvent(name, {
      type: 'agent_message_chunk',
      sessionId: `sess-${p.threadId}`,
      content: { type: 'text', text },
    })
    return { stopReason: 'end_turn' }
  }
}
// `prose` needs the harness's registry; tests set this before use.
const harnessRefs: { agents: ReturnType<typeof fakeRegistry> } = { agents: fakeRegistry() }

describe('matrix transport / human-thread completion notice', () => {
  it('posts exactly one top-level notice (no threadRoot) for a human-rooted finished turn', async () => {
    const h = makeHarness([architect])
    harnessRefs.agents = h.agents
    h.agents.prompt.mockImplementation(prose('All done.') as never)

    await post(h.transport, [humanRootEvent()])
    await settle()

    const found = notices(h.client)
    expect(found).toHaveLength(1)
    const call = found[0]!
    expect(call.threadRoot).toBeUndefined()
    expect(call.content!.formatted_body).toContain(
      'https://matrix.to/#/!r%3Aexample.com/%24msg-1?via=example.com',
    )
    expect(call.content!.formatted_body).toContain('<a href=')
    expect(call.content!.formatted_body).toContain('Open thread')
  })

  it('stays silent when the feature flag is off for the agent', async () => {
    const off: AgentBinding = { ...architect, announceHumanThreadCompletion: false }
    const h = makeHarness([off])
    harnessRefs.agents = h.agents
    h.agents.prompt.mockImplementation(prose('All done.') as never)

    await post(h.transport, [humanRootEvent()])
    await settle()
    expect(notices(h.client)).toHaveLength(0)
  })

  it('stays silent for a handoff-arc sub-session (only the thread master announces)', async () => {
    const h = makeHarness([architect, builder])
    harnessRefs.agents = h.agents
    h.agents.prompt.mockImplementation(prose('working') as never)

    // Thread master turn (human root, architect).
    await post(h.transport, [humanRootEvent()])
    await settle()
    h.client.sendMessage.mockClear()

    // Architect hands off to builder; builder runs as a sub-session.
    await post(h.transport, [
      {
        type: 'm.room.message',
        event_id: '$call',
        room_id: ROOM,
        sender: '@architect:example.com',
        content: {
          msgtype: 'm.text',
          body: 'builder do it',
          'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
          'dev.zooid.handoff': {
            version: 1,
            call_id: 'c1',
            caller: '@architect:example.com',
            callee: '@builder:example.com',
          },
        },
      },
    ])
    await settle()
    expect(notices(h.client)).toHaveLength(0)
  })

  it('stays silent for a task-assignee / delegated thread', async () => {
    const h = makeHarness([architect, builder])
    harnessRefs.agents = h.agents
    h.agents.prompt.mockImplementation(prose('task output') as never)

    // Architect starts a delegated task for builder — the task thread root is
    // the assignment event, registered in the task registry.
    const started = await h.transport.taskActions.startTasks(
      {
        agentName: 'architect',
        channelId: ROOM,
        threadRoot: '$root',
        sessionKey: '$root',
      },
      { tasks: [{ agent: 'builder', prompt: 'do it' }], notify: 'none' },
    )
    expect(started.results[0]!.status).toBe('started')
    const taskRoot = (started.results[0] as { thread_id: string }).thread_id
    h.client.sendMessage.mockClear()

    // Feed the assignment event (task root) back in; builder is the assignee.
    await post(h.transport, [
      {
        type: 'm.room.message',
        event_id: taskRoot,
        room_id: ROOM,
        sender: '@architect:example.com',
        content: {
          msgtype: 'm.text',
          body: 'do it',
          'm.mentions': { user_ids: ['@builder:example.com'] },
        },
      },
    ])
    await settle()
    expect(notices(h.client)).toHaveLength(0)
  })

  it('stays silent when the thread root was authored by an agent', async () => {
    const h = makeHarness([builderAny])
    harnessRefs.agents = h.agents
    h.agents.prompt.mockImplementation(prose('output') as never)

    await post(h.transport, [
      {
        type: 'm.room.message',
        event_id: '$root',
        room_id: ROOM,
        sender: '@architect:example.com',
        content: { msgtype: 'm.text', body: 'builder go' },
      },
    ])
    await settle()
    expect(notices(h.client)).toHaveLength(0)
  })

  it('stays silent for a trigger-stamped root', async () => {
    const h = makeHarness([builderAny])
    harnessRefs.agents = h.agents
    h.agents.prompt.mockImplementation(prose('brief body') as never)

    await post(h.transport, [
      {
        type: 'm.room.message',
        event_id: '$root',
        room_id: ROOM,
        sender: '@cron:example.com',
        content: {
          msgtype: 'm.text',
          body: 'scheduled',
          'dev.zooid.trigger': { name: 'daily', fired_at: Date.now() },
        },
      },
    ])
    await settle()
    expect(notices(h.client)).toHaveLength(0)
  })

  it('stays silent for a #brief root authored by the brief agent', async () => {
    const briefRoom = '!brief:example.com'
    const brief: AgentBinding = {
      name: 'builder',
      userId: '@builder:example.com',
      rooms: [{ alias: briefRoom }],
      trigger: 'any',
      announceHumanThreadCompletion: true,
    }
    const h = makeHarness([brief])
    harnessRefs.agents = h.agents
    h.agents.prompt.mockImplementation(prose('the brief') as never)

    await post(h.transport, [
      {
        type: 'm.room.message',
        event_id: '$root',
        room_id: briefRoom,
        sender: '@brief:example.com',
        content: { msgtype: 'm.text', body: 'daily brief' },
      },
    ])
    await settle()
    expect(notices(h.client)).toHaveLength(0)
  })

  it('stays silent when the agent is waiting on the owner (pending question)', async () => {
    const pendingInput: PendingInput = { countFor: () => 1, cancelFor: () => {} }
    const h = makeHarness([architect], { pendingInput })
    harnessRefs.agents = h.agents
    h.agents.prompt.mockImplementation(prose('which one?') as never)

    await post(h.transport, [humanRootEvent()])
    await settle()
    expect(notices(h.client)).toHaveLength(0)
  })

  it('stays silent when the thread master has an open handoff outstanding', async () => {
    const h = makeHarness([architect, builder])
    harnessRefs.agents = h.agents
    h.agents.prompt.mockImplementation(prose('waiting on builder') as never)

    await post(h.transport, [humanRootEvent()])
    await settle()
    h.client.sendMessage.mockClear()

    // Thread master opens a handoff and ends; the thread is not done.
    const ho = await h.transport.taskActions.handoff(
      { agentName: 'architect', channelId: ROOM, threadRoot: '$root', sessionKey: '$root' },
      { agent: 'builder', prompt: 'builder, take it' },
    )
    expect(ho.status).toBe('started')

    // A follow-up wakes the master again; still holding the handoff, no notice.
    await post(h.transport, [
      {
        type: 'm.room.message',
        event_id: '$follow',
        room_id: ROOM,
        sender: OWNER,
        content: {
          msgtype: 'm.text',
          body: 'any update?',
          'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
        },
      },
    ])
    await settle()
    expect(notices(h.client)).toHaveLength(0)
  })

  it('falls back to the thread root when the last event id could not be captured', async () => {
    const h = makeHarness([architect], { dropEventIds: true })
    harnessRefs.agents = h.agents
    h.agents.prompt.mockImplementation(prose('done') as never)

    await post(h.transport, [humanRootEvent()])
    await settle()
    const found = notices(h.client)
    expect(found).toHaveLength(1)
    expect(found[0]!.content!.formatted_body).toContain(
      'https://matrix.to/#/!r%3Aexample.com/%24root?via=example.com',
    )
  })
})

describe('matrix event permalink', () => {
  it('percent-encodes the sigils in room and event ids', () => {
    expect(matrixEventPermalink('!r:example.com', '$root', 'example.com')).toBe(
      'https://matrix.to/#/!r%3Aexample.com/%24root?via=example.com',
    )
  })

  it('percent-encodes a legacy $hash:domain event id', () => {
    expect(matrixEventPermalink('!a:b', '$hash:domain', 'b')).toBe(
      'https://matrix.to/#/!a%3Ab/%24hash%3Adomain?via=b',
    )
  })
})

describe('completion summary', () => {
  it('collapses whitespace and caps length', () => {
    expect(completionSummary('  hello \n\n world  ')).toBe('hello world')
    const long = 'word '.repeat(100)
    expect(completionSummary(long).length).toBeLessThanOrEqual(141)
    expect(completionSummary(long).endsWith('…')).toBe(true)
  })

  it('returns empty for no prose', () => {
    expect(completionSummary(undefined)).toBe('')
  })
})
