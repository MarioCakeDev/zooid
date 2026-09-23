import type {
  AvailableCommandsEvent,
  PlanEvent,
  TapEvent,
  ToolCallEvent,
  ToolCallUpdateEvent,
} from '@zooid/acp-client'

/** Cap any single string in rawInput so big diffs / file contents don't bloat Matrix. */
const RAW_INPUT_STR_MAX = 250

export function toToolCallBody(evt: ToolCallEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {
    session_id: evt.sessionId,
    tool_call_id: evt.toolCallId,
    title: evt.title,
  }
  if (evt.kind !== undefined) out.kind = evt.kind
  if (evt.status !== undefined) out.status = evt.status
  if (evt.rawInput !== undefined) out.raw_input = truncateStrings(evt.rawInput, RAW_INPUT_STR_MAX)
  if (evt.locations !== undefined) out.locations = evt.locations
  return out
}

/**
 * Recursively truncates string values longer than `max` with a "… [truncated]"
 * suffix. Non-string scalars and structure are preserved.
 */
function truncateStrings(v: unknown, max: number): unknown {
  if (typeof v === 'string') {
    return v.length > max ? v.slice(0, max) + '… [truncated]' : v
  }
  if (Array.isArray(v)) {
    return v.map((item) => truncateStrings(item, max))
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = truncateStrings(val, max)
    }
    return out
  }
  return v
}

export function toUpdateBody(evt: ToolCallUpdateEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {
    session_id: evt.sessionId,
    tool_call_id: evt.toolCallId,
  }
  if (evt.status !== undefined) out.status = evt.status
  if (evt.kind !== undefined) out.kind = evt.kind
  // content[] carries display-ready output (text/diff/terminal); rawOutput is
  // intentionally NOT serialized — it's typically large and duplicates content.
  if (evt.content !== undefined) out.content = evt.content
  // Some ACP agents only set rawInput on a later update (not the initial
  // tool_call). Truncate strings and forward.
  if (evt.rawInput !== undefined) out.raw_input = truncateStrings(evt.rawInput, RAW_INPUT_STR_MAX)
  if (evt.locations !== undefined) out.locations = evt.locations
  return out
}

export function toPlanBody(evt: PlanEvent): Record<string, unknown> {
  return {
    session_id: evt.sessionId,
    entries: evt.entries,
  }
}

export function toAvailableCommandsBody(
  evt: AvailableCommandsEvent,
): Record<string, unknown> {
  return {
    session_id: evt.sessionId,
    available_commands: evt.commands.map((c) => ({
      name: c.name,
      description: c.description,
    })),
  }
}

const RECOVERY_URLS: Partial<Record<string, string>> = {
  auth_missing: 'https://zooid.dev/docs/guides/run-in-container#authentication-that-carries-over',
  auth_invalid: 'https://zooid.dev/docs/guides/run-in-container#authentication-that-carries-over',
  mount_failed: 'https://zooid.dev/docs/guides/run-in-container#what-you-get-for-free',
  image_pull_failed: 'https://zooid.dev/docs/guides/run-in-container#skipping-the-image-prepull',
}

type ErrorTap = Extract<TapEvent, { kind: 'error' }>

export function toErrorBody(evt: ErrorTap, threadRoot: string): Record<string, unknown> {
  const msg = evt.message.slice(0, 250)
  const out: Record<string, unknown> = {
    // No msgtype: dev.zooid.error is not m.room.message, so the field is
    // meaningless here — it was a vestige of copying the message-body shape.
    // Its presence used to force careful push-rule `before` positioning
    // (ZNC025 §10); that positioning is kept regardless, since it also
    // protects rules for event types that never carried the field.
    body: `⚠ [${evt.code}] ${msg}`,
    code: evt.code,
    message: msg,
    transient: evt.transient,
    'm.relates_to': { rel_type: 'm.thread', event_id: threadRoot },
  }
  if (evt.sessionId) out.session_id = evt.sessionId
  if (evt.turnId) out.turn_id = evt.turnId
  if (evt.detail) out.detail = evt.detail.slice(0, 2000)
  if (evt.acp_error) out.acp_error = evt.acp_error
  const recovery = RECOVERY_URLS[evt.code]
  if (recovery) out.recovery = recovery
  return out
}

/** Cap a mirror notice so a huge plan / command roster stays glanceable. */
const NOTICE_MAX = 400

function clamp(s: string, max = NOTICE_MAX): string {
  const oneLine = s.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** First display-ready text block in a tool_call_update's `content[]`. */
function summarizeToolContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  for (const item of content) {
    const block = item as { text?: unknown; content?: { text?: unknown } } | null
    if (!block) continue
    const text = nonEmptyString(block.text) ?? nonEmptyString(block.content?.text)
    if (text) return text
  }
  return undefined
}

/**
 * Compact, human-readable mirror body for an outbound `dev.zooid.*` activity
 * event, so a stock Matrix client (Element X / Desktop / Web) that cannot render
 * the custom event still shows what the agent is doing. The custom event is
 * still sent — the Zooid client needs it.
 *
 * Returns `null` (do not mirror) for:
 *  - `dev.zooid.turn.end`: a per-turn boundary marker whose `body` is a
 *    push-notification preview, not timeline content — mirroring it would add
 *    a redundant "agent finished" line every turn;
 *  - the `dev.zooid.workforce` state event, which lives in an `m.space`
 *    container (Element surfaces membership through the space, not a message
 *    timeline);
 *  - thread results and any unknown type.
 *
 * `dev.zooid.error` is mirrored even though it carries a body: it is rare,
 * high-value, and a stock client cannot render the custom event, so the
 * duplicate line in a client that *does* render it is acceptable.
 */
export function toActivityNoticeBody(
  eventType: string,
  content: Record<string, unknown>,
): string | null {
  if (eventType === 'dev.zooid.error') {
    const body = nonEmptyString(content.body)
    return body ? clamp(body) : null
  }
  if (nonEmptyString(content.body)) return null
  switch (eventType) {
    case 'dev.zooid.tool_call': {
      const title = nonEmptyString(content.title) ?? nonEmptyString(content.tool_call_id) ?? 'tool'
      const detail = nonEmptyString(content.status) ?? nonEmptyString(content.kind)
      return clamp(`🔧 ${title}${detail ? ` — ${detail}` : ''}`)
    }
    case 'dev.zooid.tool_call_update': {
      const detail =
        summarizeToolContent(content.content) ??
        nonEmptyString(content.status) ??
        'updated'
      const id = nonEmptyString(content.tool_call_id)
      return clamp(`↳ ${detail}${id ? ` (${id.slice(0, 8)})` : ''}`)
    }
    case 'dev.zooid.plan': {
      const entries = Array.isArray(content.entries) ? content.entries : []
      const lines = entries
        .map((e) => nonEmptyString((e as Record<string, unknown> | null)?.content))
        .filter((x): x is string => Boolean(x))
      const head = lines.slice(0, 4).join('; ')
      const more = lines.length > 4 ? ` (+${lines.length - 4} more)` : ''
      return clamp(`🗒 Plan (${lines.length} steps): ${head}${more}`)
    }
    case 'dev.zooid.available_commands_update': {
      const cmds = Array.isArray(content.available_commands) ? content.available_commands : []
      const names = cmds
        .map((c) => nonEmptyString((c as Record<string, unknown> | null)?.name))
        .filter((x): x is string => Boolean(x))
      return clamp(`⌘ Commands: ${names.join(', ')}`)
    }
    case 'dev.zooid.approval_request': {
      const id = nonEmptyString(content.approval_id)
      const title = nonEmptyString(content.tool_title) ?? nonEmptyString(content.tool_call_id) ?? 'a tool call'
      const idPart = id ? ` (id ${id})` : ''
      return clamp(
        `🔐 Approval needed: ${title}${idPart} — reply "approve ${id ?? '<id>'}" or ` +
          `"deny ${id ?? '<id>'}", or react ✅/❌`,
      )
    }
    default:
      return null
  }
}

export interface TurnEnd {
  agentId: string
  sessionId: string
  producedOutput: boolean
  /** The turn's final assistant message, for the push notification's preview. */
  lastMessage?: string
}

/** Push payloads are size-capped, and a notification body is glanceable or useless. */
const PREVIEW_MAX = 140

/**
 * Turn-boundary marker for [[ZOD076]] and push notifications. Carries no
 * `msgtype` — a vestigial one (as `toErrorBody` used to carry) would collide
 * with `.m.rule.suppress_notices`'s type-agnostic match and silently swallow
 * the event before the [[ZNC025]] agent push rule ever sees it.
 */
export function toTurnEndBody(evt: TurnEnd, threadRoot: string): Record<string, unknown> {
  const preview = evt.lastMessage?.trim().replace(/\s+/g, ' ')
  return {
    // `body` stays the turn-boundary summary: it is what a generic Matrix
    // client renders for this event, and the prose is already its own message
    // in the timeline. The preview below exists only for the push, which
    // cannot see that message — agent prose is `m.notice`, deliberately
    // silenced by `.m.rule.suppress_notices` so a chatty turn doesn't fire one
    // push per chunk ([[ZNC025]] §10). Without it the only notification the
    // user gets says an agent finished and nothing about what it said.
    body: evt.producedOutput ? `${evt.agentId} finished` : `${evt.agentId} finished without output`,
    ...(preview ? { last_message: preview.slice(0, PREVIEW_MAX) } : {}),
    agent_id: evt.agentId,
    session_id: evt.sessionId,
    produced_output: evt.producedOutput,
    'm.relates_to': { rel_type: 'm.thread', event_id: threadRoot },
  }
}
