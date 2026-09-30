import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createMatrixTransport } from './transport.js'
import type { AgentEvent } from '@zooid/acp-client'

/**
 * The daemon recovers from a wedged session underneath the transport, which
 * means two things the transport has to get right or the fix is invisible:
 *
 *  1. It has to *say* something. The whole failure was silent — the owner's
 *     only signal was absence — so a recovery that isn't announced in-thread is
 *     not a recovery.
 *  2. It has to follow the session across the swap. Every per-session map here
 *     is keyed by ACP session id; if they don't move, the replayed turn's
 *     chunks arrive for a session the transport doesn't know and get dropped
 *     as orphans — the exact silence we're fixing.
 */

function fakeRegistry() {
  let resolvePrompt: (() => void) | undefined
  const promptPending = new Promise<void>((r) => {
    resolvePrompt = r
  })
  // The session the turn ultimately ran on — the registry reports a different
  // one than the caller passed in when it had to recover from a wedge.
  const state = { promptSessionId: undefined as string | undefined }
  const reg = {
    hasAgent: vi.fn(() => true),
    ensureSession: vi.fn(
      async (_name: string, threadId: string, _roomId: string) => `sess-${threadId}`,
    ),
    endSession: vi.fn(),
    cancelSession: vi.fn(async () => {}),
    prompt: vi.fn(async () => {
      await promptPending
      return { stopReason: 'end_turn' as const, sessionId: state.promptSessionId }
    }),
    stopAll: vi.fn(async () => {}),
    getApprovalTimeoutMs: vi.fn(() => 0),
    onEvent: vi.fn() as unknown as (n: string, e: unknown) => void,
    onApprovalRequest: vi.fn(async () => ({ decision: 'cancel' as const })),
    onSessionRekey: undefined as
      | ((n: string, t: string, prev: string, next: string) => void)
      | undefined,
  }
  return { reg, state, finishPrompt: () => resolvePrompt!() }
}

function fakeApprovals() {
  const e = new EventEmitter()
  return Object.assign(e, {
    register: vi.fn(),
    resolve: vi.fn(() => true),
    get: vi.fn(() => undefined),
    resolveById: vi.fn(() => false),
    cancelSession: vi.fn(),
    listPending: vi.fn(() => []),
  })
}

function fakeClient() {
  let n = 0
  return {
    registerBot: vi.fn(async () => undefined),
    joinRoom: vi.fn(async () => undefined),
    leaveRoom: vi.fn(async () => undefined),
    sendMessage: vi.fn(async (_msg: unknown) => ({ event_id: `$msg-${++n}` })),
    sendCustomEvent: vi.fn(async (_evt: unknown) => ({ event_id: `$custom-${++n}` })),
    fetchEvent: vi.fn(async () => null),
    setTyping: vi.fn(async () => {}),
    setPresence: vi.fn(async () => {}),
  }
}

const bindings = [
  {
    name: 'dev',
    userId: '@agent.dev:example.com',
    rooms: [{ alias: '!r:example.com' }],
    trigger: 'mention' as const,
  },
]

function makeTransport() {
  const { reg, state, finishPrompt } = fakeRegistry()
  const approvals = fakeApprovals()
  const client = fakeClient()
  const transport = createMatrixTransport({
    agents: reg as never,
    approvals: approvals as never,
    client: client as never,
    bindings,
    hsToken: 'hs-secret',
    botUserId: '@zooid:example.com',
    drainQuietMs: 0,
  })
  return { transport, agents: reg, state, approvals, client, finishPrompt }
}

let txn = 0
async function mention(app: ReturnType<typeof makeTransport>['transport']['app'], eventId: string) {
  return app.request(`/_matrix/app/v1/transactions/txn${++txn}`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer hs-secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      events: [
        {
          type: 'm.room.message',
          event_id: eventId,
          room_id: '!r:example.com',
          sender: '@alice:example.com',
          content: {
            msgtype: 'm.text',
            body: '@agent.dev:example.com continue',
            'm.mentions': { user_ids: ['@agent.dev:example.com'] },
          },
        },
      ],
    }),
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r))
}

/** Bodies of every custom event the agent sent, by event type. */
function customEvents(client: ReturnType<typeof fakeClient>, eventType: string) {
  return client.sendCustomEvent.mock.calls
    .map((c) => c[0] as unknown as { eventType: string; content: Record<string, unknown> })
    .filter((c) => c.eventType === eventType)
    .map((c) => c.content)
}

function mirrorBodies(client: ReturnType<typeof fakeClient>) {
  return client.sendMessage.mock.calls
    .map((c) => ((c[0] as unknown as { content: { body?: string } }).content?.body))
    .filter((b): b is string => typeof b === 'string')
}

describe('matrix transport — wedged session recovery', () => {
  it('announces the recovery in-thread instead of failing silently', async () => {
    const { transport, agents, client } = makeTransport()
    await mention(transport.app, '$root')
    await settle()
    const sessionId = `sess-$root`
    agents.onEvent('dev', {
      type: 'session_wedge',
      sessionId,
      recovered: true,
      attempt: 1,
      maxAttempts: 2,
      recoveredSessionId: 'sess-fresh',
    })
    await settle()

    const errors = customEvents(client, 'dev.zooid.error')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.code).toBe('session_wedge')
    expect(errors[0]!['m.relates_to']).toEqual({ rel_type: 'm.thread', event_id: '$root' })
    // The stock-client mirror says it in plain words — the owner's only signal
    // used to be absence, so the wording has to be explicit about the replay.
    const mirror = mirrorBodies(client).find((b) => b.includes('wedged'))
    expect(mirror).toBeDefined()
    expect(mirror).toContain('replaying your last message')
  })

  it('says so when recovery failed, instead of claiming a replay that never happened', async () => {
    const { transport, agents, client } = makeTransport()
    await mention(transport.app, '$root')
    await settle()
    agents.onEvent('dev', {
      type: 'session_wedge',
      sessionId: 'sess-$root',
      recovered: false,
      attempt: 2,
      maxAttempts: 2,
    })
    await settle()
    const mirror = mirrorBodies(client).find((b) => b.includes('wedged'))
    expect(mirror).toContain('could not be recovered')
    expect(mirror).not.toContain('replaying your last message')
  })

  it('keeps delivering the replayed turn after the session is re-keyed', async () => {
    const { transport, agents, state, client, finishPrompt } = makeTransport()
    await mention(transport.app, '$root')
    await settle()
    // The registry swaps the session under us while the turn is still running,
    // then reports the session the replay actually ran on.
    state.promptSessionId = 'sess-recovered'
    agents.onSessionRekey!('dev', '$root', 'sess-$root', 'sess-recovered')
    agents.onEvent('dev', {
      type: 'agent_message_chunk',
      sessionId: 'sess-recovered',
      content: { type: 'text', text: 'recovered answer' },
    })
    finishPrompt()
    await settle()
    expect(mirrorBodies(client)).toContain('recovered answer')
  })

  it('cancels approvals stranded on the wedged session', async () => {
    const { transport, agents, approvals } = makeTransport()
    await mention(transport.app, '$root')
    await settle()
    agents.onSessionRekey!('dev', '$root', 'sess-$root', 'sess-recovered')
    expect(approvals.cancelSession).toHaveBeenCalledWith('sess-$root')
  })

  it('gives the replayed turn a fresh mirror state, not a missing one', async () => {
    const { transport, agents, state, client, finishPrompt } = makeTransport()
    await mention(transport.app, '$root')
    await settle()
    state.promptSessionId = 'sess-recovered'
    agents.onSessionRekey!('dev', '$root', 'sess-$root', 'sess-recovered')
    // A tool call on the recovered session: the turn-end summary line only
    // exists if the fresh mirror state was seeded (an unseeded one makes
    // finalizeTurnMirror a silent no-op and the turn posts no summary at all).
    agents.onEvent('dev', {
      type: 'tool_call',
      sessionId: 'sess-recovered',
      toolCallId: 'call-1',
      title: 'read',
      kind: 'read',
    })
    finishPrompt()
    await settle()
    const bodies = mirrorBodies(client).join('\n')
    expect(bodies).toContain('1 tool')
  })

  it('carries the command roster across the re-key', async () => {
    const { transport, agents, client } = makeTransport()
    await mention(transport.app, '$root')
    await settle()
    // The fresh session advertised its roster during ensureSession, before the
    // rekey hook fired, so it is still stashed under the new id.
    agents.onSessionRekey!('dev', '$root', 'sess-$root', 'sess-recovered')
    agents.onEvent('dev', {
      type: 'available_commands',
      sessionId: 'sess-recovered',
      commands: [{ name: 'compact', description: 'compact the session' }],
    })
    await settle()
    const roster = customEvents(client, 'dev.zooid.available_commands_update')
    expect(roster).toHaveLength(1)
  })

  it('drops a wedge notice when the session is unknown to the transport', async () => {
    const { transport, agents, client } = makeTransport()
    agents.onEvent('dev', {
      type: 'session_wedge',
      sessionId: 'never-seen',
      recovered: true,
      attempt: 1,
      maxAttempts: 2,
    } as AgentEvent)
    await settle()
    expect(customEvents(client, 'dev.zooid.error')).toHaveLength(0)
  })
})