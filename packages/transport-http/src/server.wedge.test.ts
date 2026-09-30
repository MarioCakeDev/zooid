import { describe, it, expect, vi } from 'vitest'
import type { AcpRegistry, AcpRegistryEventHandler } from '@zooid/core'
import { ApprovalCorrelator } from '@zooid/core'
import type { AgentEvent } from '@zooid/acp-client'
import { createApp } from './server.js'

/**
 * The HTTP transport keys its SSE handle by ACP session id, and the recovery
 * path *moves* that handle to the replacement session before the wedge notice
 * is emitted. A handler that reads only `event.sessionId` therefore drops the
 * notice on every successful recovery — which, for an HTTP client, is the same
 * silent restart this whole change exists to eliminate.
 */

const TOKEN = 'unit-test-token-9f2c'
const SID = '11111111-2222-3333-4444-555555555555'
const FRESH = '99999999-8888-7777-6666-555555555555'

type Rekey = (n: string, t: string, prev: string, next: string) => void

function makeRegistry(): { reg: AcpRegistry; emit: (name: string, e: AgentEvent) => void; rekey: Rekey } {
  let onEvent: AcpRegistryEventHandler = () => {}

  let onEventRekey: Rekey = () => {}
  const reg = {
    hasAgent: () => true,
    getApprovalTimeoutMs: () => 0,
    ensureSession: vi.fn(async () => SID),
    endSession: vi.fn(),
    prompt: vi.fn(async (name: string) => {
      // Exactly what the real registry does on a wedge: re-key first, then
      // report it, with the notice carrying the *old* session id.
      onEventRekey(name, 'thread', SID, FRESH)
      onEvent(name, {
        type: 'session_wedge',
        sessionId: SID,
        recovered: true,
        attempt: 1,
        maxAttempts: 2,
        recoveredSessionId: FRESH,
      })
      onEvent(name, {
        type: 'agent_message_chunk',
        sessionId: FRESH,
        content: { type: 'text', text: 'recovered answer' },
      })
      return { stopReason: 'end_turn' as const, sessionId: FRESH }
    }),
    stopAll: vi.fn(async () => {}),
    get onEvent() {
      return onEvent
    },
    set onEvent(h) {
      onEvent = h
    },
    onApprovalRequest: async () => ({ decision: 'cancel' as const }),
    get onSessionRekey() {
      return onEventRekey
    },
    set onSessionRekey(h) {
      onEventRekey = h
    },
  } as unknown as AcpRegistry

  return {
    reg,
    emit: (name, e) => onEvent(name, e),
    rekey: (n, t, p, nx) => onEventRekey(n, t, p, nx),
  }
}

function parseFrames(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n\n')
    .filter((f) => f.startsWith('data: '))
    .map((f) => JSON.parse(f.slice('data: '.length)) as Record<string, unknown>)
}

describe('POST /agents/:name/sessions — wedged session recovery', () => {
  it('delivers the recovery notice and the replayed turn to the same client', async () => {
    const { reg } = makeRegistry()
    const app = createApp({ agents: reg, approvals: new ApprovalCorrelator(), token: TOKEN })
    const res = await app.request('/agents/triage/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ prompt: 'continue' }),
    })
    const frames = parseFrames(await res.text())
    // The notice is on the wire even though its sessionId is the dead one.
    const wedge = frames.find((f) => f.type === 'session_wedge')
    expect(wedge).toMatchObject({ recovered: true, sessionId: SID, recoveredSessionId: FRESH })
    // …and so is the replayed turn, which arrived under the new session id.
    expect(frames.some((f) => f.type === 'agent_message_chunk')).toBe(true)
  })

  it('ends the turn against the recovered session', async () => {
    const { reg } = makeRegistry()
    const app = createApp({ agents: reg, approvals: new ApprovalCorrelator(), token: TOKEN })
    const res = await app.request('/agents/triage/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ prompt: 'continue' }),
    })
    const frames = parseFrames(await res.text())
    expect(frames[frames.length - 1]).toMatchObject({ type: 'turn.end', stop_reason: 'end_turn' })
  })

  it('drops a notice whose session has no attached stream instead of crashing', async () => {
    const { reg, emit } = makeRegistry()
    const app = createApp({ agents: reg, approvals: new ApprovalCorrelator(), token: TOKEN })
    expect(() =>
      emit('triage', {
        type: 'session_wedge',
        sessionId: null,
        recovered: false,
        attempt: 2,
        maxAttempts: 2,
      }),
    ).not.toThrow()
  })
})