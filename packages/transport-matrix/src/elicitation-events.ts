import type { ElicitationResolution, PendingElicitation } from '@zooid/core'
import { elicitationFields, singleEnumField } from './elicitation-commands.js'

export const ElicitationEventType = {
  Request: 'dev.zooid.elicitation_request',
  Response: 'dev.zooid.elicitation_response',
  Resolved: 'dev.zooid.elicitation_resolved',
  Rejected: 'dev.zooid.elicitation_rejected',
} as const

const inThread = (root: string) => ({ 'm.relates_to': { rel_type: 'm.thread', event_id: root } })

export function toElicitationRequestBody(r: PendingElicitation): Record<string, unknown> {
  return {
    version: 1,
    request_id: r.requestId,
    session_id: r.sessionId,
    ...(r.toolCallId ? { tool_call_id: r.toolCallId } : {}),
    message: r.message,
    // The ACP schema travels untouched — property names and _meta included.
    requested_schema: r.requestedSchema,
    ...(r.meta ? { meta: r.meta } : {}),
    // Fallback for clients that can't render the form (and push previews).
    body: `❓ ${r.message}`,
    ...inThread(r.threadRoot),
  }
}

export function toElicitationResolvedBody(res: ElicitationResolution): Record<string, unknown> {
  return {
    version: 1,
    request_id: res.record.requestId,
    request_event_id: res.record.requestEventId,
    status: res.status,
    ...(res.content ? { content: res.content } : {}),
    ...(res.respondedBy ? { responded_by: res.respondedBy } : {}),
    ...(res.responseEventId ? { response_event_id: res.responseEventId } : {}),
    ...(res.reason ? { reason: res.reason } : {}),
    ...inThread(res.record.threadRoot),
  }
}

export function toElicitationRejectedBody(o: {
  record: PendingElicitation
  responseEventId: string
  reason: 'invalid' | 'stale'
  errors?: Record<string, string>
}): Record<string, unknown> {
  return {
    version: 1,
    request_id: o.record.requestId,
    request_event_id: o.record.requestEventId,
    response_event_id: o.responseEventId,
    reason: o.reason,
    ...(o.errors ? { errors: o.errors } : {}),
    ...inThread(o.record.threadRoot),
  }
}

const NUMBER_REACTIONS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣']

/**
 * Stock-Element mirror of a form request: the question, one bullet per field
 * (with its choices), and the exact reply/reaction commands that answer it.
 * The transport posts this as a mirror-marked `m.notice` in the request's
 * thread; the custom `dev.zooid.elicitation_request` event is unchanged.
 */
export function toElicitationNoticeBody(record: PendingElicitation, agentName?: string): string {
  const who = agentName && agentName.length > 0 ? agentName : 'An agent'
  const id = record.requestId
  const lines: string[] = [`❓ ${who} asks: ${record.message}`]
  const fields = elicitationFields(record.requestedSchema)
  if (fields.length > 0) {
    lines.push('')
    for (const f of fields) {
      const label = `${f.name}${f.required ? ' (required)' : ''}`
      if (f.choices && f.choices.length > 0) {
        const joined = f.choices.join(', ')
        lines.push(
          f.type === 'array' ? `• ${label} — choose from: ${joined}` : `• ${label} — one of: ${joined}`,
        )
      } else {
        lines.push(`• ${label} — ${f.type}`)
      }
    }
  }
  lines.push('')
  const single = singleEnumField(record.requestedSchema)
  const reaction = single
    ? `  ·  react ${NUMBER_REACTIONS.slice(0, single.choices.length).join(' ')}`
    : ''
  lines.push(`Answer: \`answer ${id} <value>\`${reaction}`)
  if (fields.length > 1) {
    lines.push(`Multiple fields — use JSON: \`answer ${id} {"field":"value"}\``)
  }
  lines.push(`Or: \`decline ${id}\`  ·  \`cancel ${id}\``)
  return lines.join('\n')
}

function renderOutcomeContent(content: unknown): string {
  if (content === undefined || content === null) return ''
  if (typeof content !== 'object' || Array.isArray(content)) return JSON.stringify(content)
  const parts = Object.entries(content as Record<string, unknown>).map(([k, v]) =>
    Array.isArray(v) ? `${k}=${v.join(', ')}` : `${k}=${String(v)}`,
  )
  return parts.length > 0 ? parts.join(', ') : '(empty)'
}

/** The one-line outcome appended to a notice when a request reaches a terminal state. */
export function toElicitationOutcomeBody(res: ElicitationResolution): string {
  if (res.status === 'accepted') {
    const who = res.respondedBy ? ` by ${res.respondedBy}` : ''
    const value = renderOutcomeContent(res.content)
    return `✅ Answered${who}${value ? `: ${value}` : ''}`
  }
  if (res.status === 'declined') {
    return `➖ Declined${res.respondedBy ? ` by ${res.respondedBy}` : ''}`
  }
  if (res.status === 'cancelled') {
    return `🚫 Cancelled${res.reason ? ` (${res.reason})` : ''}`
  }
  return `— ${res.status}`
}

export interface ParsedElicitationResponse {
  requestId: string
  requestEventId: string
  action: 'accept' | 'decline' | 'cancel'
  content?: unknown
  threadRoot: string
}

/** Envelope only. Any session_id in the content is ignored on purpose. */
export function parseElicitationResponse(evt: { content?: Record<string, unknown> }): ParsedElicitationResponse | null {
  const c = evt.content ?? {}
  const rel = c['m.relates_to'] as { rel_type?: string; event_id?: string } | undefined
  if (rel?.rel_type !== 'm.thread' || !rel.event_id) return null
  if (typeof c.request_id !== 'string' || typeof c.request_event_id !== 'string') return null
  if (c.action !== 'accept' && c.action !== 'decline' && c.action !== 'cancel') return null
  return {
    requestId: c.request_id,
    requestEventId: c.request_event_id,
    action: c.action,
    ...(c.action === 'accept' ? { content: c.content === undefined ? {} : c.content } : {}),
    threadRoot: rel.event_id,
  }
}
