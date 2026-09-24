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

/**
 * Marker on every mirror line (create and edit; see `turnMirrorNoticeContent` /
 * `turnMirrorEditContent`). It rides in the notice's content and in
 * `m.new_content`, so a client that renders the native `dev.zooid.*` events (the
 * Zooid web client) can hide the line with a single check, and the router guard
 * never routes it as a mention. Stock Element ignores the unknown field.
 */
export const TURN_MIRROR_MARKER = 'dev.zooid.mirror'

/**
 * Compact, human-readable mirror body for an outbound `dev.zooid.*` activity
 * event that must stand alone in the timeline. Since the per-turn mirror line
 * folds tool/plan/command activity into one editable notice, the only events
 * mirrored individually are the ones a user must be able to act on:
 *  - `dev.zooid.approval_request` — actionable (approve/deny);
 *  - `dev.zooid.error` — rare, high-value, and a stock client cannot render
 *    the custom event; its existing `body` is reused verbatim.
 *
 * Returns `null` (do not mirror) for everything else, including the foldable
 * activity events, `dev.zooid.turn.end` (a per-turn boundary marker whose
 * `body` is a push-notification preview, not timeline content), and the
 * `dev.zooid.workforce` state event.
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
  if (eventType === 'dev.zooid.approval_request') {
    const id = nonEmptyString(content.approval_id)
    const title =
      nonEmptyString(content.tool_title) ?? nonEmptyString(content.tool_call_id) ?? 'a tool call'
    const idPart = id ? ` (id ${id})` : ''
    return clamp(
      `🔐 Approval needed: ${title}${idPart} — reply "approve ${id ?? '<id>'}" or ` +
        `"deny ${id ?? '<id>'}", or react ✅/❌`,
    )
  }
  return null
}

/** Distinct tools and files a turn has touched, for the final mirror line. */
export interface TurnMirrorCounts {
  toolCount: number
  fileCount: number
}

/**
 * One tool's latest state, keyed by `tool_call_id` and held in first-seen
 * order. A mirror line lists the entries of one prose gap: a new `tool_call_id`
 * appends one, and a later `tool_call_update` for the same id mutates that entry
 * in place (title/status) — never a duplicate. Only the title and status are
 * kept: the line is titles + status, never raw tool output.
 */
export interface TurnToolEntry {
  toolCallId: string
  title: string
  /** ACP `ToolCallStatus`: pending | in_progress | completed | failed. */
  status?: string
}

/**
 * Human label for an ACP `ToolCallStatus`. `in_progress` reads as "running" —
 * the status vocabulary the summary example uses.
 */
export function toolStatusLabel(status: string | undefined): string | undefined {
  switch (status) {
    case 'pending':
      return 'pending'
    case 'in_progress':
      return 'running'
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    default:
      return undefined
  }
}

/** Leading glyph for a tool entry in the collapsed list. */
function toolStatusIcon(status: string | undefined): string {
  switch (status) {
    case 'completed':
      return '✓'
    case 'failed':
      return '✗'
    case 'in_progress':
      return '⏳'
    default:
      return '•'
  }
}

/** Cap a single collapsed tool line so a long title stays glanceable. */
const TOOL_LINE_MAX = 200

/**
 * Compact one-line rendering of a tool entry: `✓ bash — done`,
 * `⏳ edit src/x.ts`, `✗ edit — failed`. Only the title and status are shown —
 * no raw tool output. The status label appears only for terminal states (the
 * ⏳/• glyphs already convey in-flight/pending), and the whole line is clamped.
 */
export function toolEntryLine(entry: TurnToolEntry): string {
  const terminal = entry.status === 'completed' || entry.status === 'failed'
  const label = terminal ? ` — ${toolStatusLabel(entry.status)}` : ''
  return clamp(`${toolStatusIcon(entry.status)} ${entry.title}${label}`, TOOL_LINE_MAX)
}

/**
 * The single line for one run of tool/plan activity: **every tool call since the
 * previous prose message**, joined with ` · ` — e.g.
 * `🔧 dev: ⏳ bash · ✓ edit src/x.ts`. The line is created on the first activity
 * after a prose message and edited in place as more tools run, so the gap
 * between two prose messages is exactly one line (never one line per tool).
 */
export function turnGroupBody(
  agentId: string,
  entries: TurnToolEntry[],
  planDetail?: string,
): string {
  const parts = entries.map(toolEntryLine)
  if (planDetail) parts.push(`🗒 ${planDetail}`)
  return clamp(`🔧 ${agentId}: ${parts.join(' · ')}`)
}

/**
 * The line posted once the turn ends: one new `✅ <agent>: done · N tools ·
 * M files` notice after the last prose-gap line (`⚠️ … failed` when the turn
 * threw). It does not edit an earlier line — the counts are the distinct tools
 * and files for the whole turn. A turn with no tool/plan activity gets no
 * summary.
 */
export function turnFinalBody(agentId: string, counts: TurnMirrorCounts, failed: boolean): string {
  const tools = `${counts.toolCount} tool${counts.toolCount === 1 ? '' : 's'}`
  const files = `${counts.fileCount} file${counts.fileCount === 1 ? '' : 's'}`
  const outcome = failed ? '⚠️' : '✅'
  return `${outcome} ${agentId}: ${failed ? 'failed' : 'done'} · ${tools} · ${files}`
}

/**
 * Latest human-readable summary detail for a foldable non-tool `dev.zooid.*`
 * event. Tool activity is rendered from its `TurnToolEntry` (see
 * `toolEntryLine`) so an update mutates one entry rather than replacing the
 * whole line's detail with opaque content text.
 */
export function activityDetail(
  eventType: string,
  content: Record<string, unknown>,
): string | undefined {
  switch (eventType) {
    case 'dev.zooid.plan': {
      const entries = Array.isArray(content.entries) ? content.entries : []
      return entries.length > 0
        ? `plan (${entries.length} step${entries.length === 1 ? '' : 's'})`
        : 'plan'
    }
    case 'dev.zooid.available_commands_update': {
      const cmds = Array.isArray(content.available_commands) ? content.available_commands : []
      return `commands (${cmds.length})`
    }
    default:
      return undefined
  }
}

/**
 * Content of an interleaved mirror line: one threaded, marked `m.notice` for
 * every tool/plan activity since the previous prose message. It is created on
 * the first activity after a prose flush and edited in place as more tools run,
 * so the timeline reads prose → tool line → prose → tool line and the order of
 * execution is clear. The line carries no HTML — it is a single compact line of
 * text (see `turnGroupBody`).
 */
export function turnMirrorNoticeContent(
  body: string,
  threadRoot: string,
): {
  msgtype: string
  body: string
  [k: string]: unknown
} {
  return {
    msgtype: 'm.notice',
    body,
    [TURN_MIRROR_MARKER]: true,
    'm.relates_to': { rel_type: 'm.thread', event_id: threadRoot },
  }
}

/**
 * Content of an `m.replace` edit of an interleaved mirror line, used to mutate
 * one tool/task line in place as its status changes (never a duplicate). The
 * replacement relation rides in the top-level `m.relates_to`; the thread
 * relation goes in `m.new_content.m.relates_to` (MSC2676 + MSC3440) so Element
 * keeps the edited line inside its thread. The marker is repeated in
 * `m.new_content` because that is the content a client applies.
 */
export function turnMirrorEditContent(
  eventId: string,
  body: string,
  threadRoot: string,
): {
  msgtype: string
  body: string
  [k: string]: unknown
} {
  return {
    msgtype: 'm.notice',
    body: `* ${body}`,
    [TURN_MIRROR_MARKER]: true,
    'm.new_content': {
      msgtype: 'm.notice',
      body,
      [TURN_MIRROR_MARKER]: true,
      'm.relates_to': { rel_type: 'm.thread', event_id: threadRoot },
    },
    'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
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
