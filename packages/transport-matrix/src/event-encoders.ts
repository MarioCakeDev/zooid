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

/** Escape the five HTML-significant characters for an `org.matrix.custom.html` body. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Read one string field from a raw (unknown-shaped) tool input object. */
function inputString(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  return nonEmptyString((input as Record<string, unknown>)[key])
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
 *  - `dev.zooid.approval_request` — actionable (react 👍/👎), naming the agent
 *    and the command / file it wants to act on;
 *  - `dev.zooid.error` — rare, high-value, and a stock client cannot render
 *    the custom event; its existing `body` is reused verbatim.
 *
 * Returns `null` (do not mirror) for everything else, including the foldable
 * activity events, `dev.zooid.turn.end` (a per-turn boundary marker whose
 * `body` is a push-notification preview, not timeline content), and the
 * `dev.zooid.workforce` state event.
 */
/** Cap the rendered approval action so a big command / file path stays glanceable. */
const APPROVAL_ACTION_MAX = 160

/**
 * What an approval would do, in one glanceable verb + detail: the `command` for
 * a shell tool, the `filepath` for a write/edit, else the tool title. `toolKind`
 * picks the verb when the input itself is opaque.
 */
function approvalAction(content: Record<string, unknown>): { verb: string; detail: string } {
  const kind = nonEmptyString(content.tool_kind)
  const title = nonEmptyString(content.tool_title)
  const command = inputString(content.tool_input, 'command')
  if (command) return { verb: 'run', detail: clamp(command, APPROVAL_ACTION_MAX) }
  const filepath =
    inputString(content.tool_input, 'filepath') ??
    inputString(content.tool_input, 'file_path') ??
    inputString(content.tool_input, 'path')
  if (filepath) {
    return { verb: kind === 'write' ? 'write' : 'edit', detail: clamp(filepath, APPROVAL_ACTION_MAX) }
  }
  const verb =
    kind === 'execute' ? 'run' : kind === 'write' ? 'write' : kind === 'edit' ? 'edit' : 'use'
  return { verb, detail: clamp(title ?? kind ?? 'a tool call', APPROVAL_ACTION_MAX) }
}

export function toActivityNoticeBody(
  eventType: string,
  content: Record<string, unknown>,
  agentName?: string,
): string | null {
  if (eventType === 'dev.zooid.error') {
    const body = nonEmptyString(content.body)
    return body ? clamp(body) : null
  }
  if (nonEmptyString(content.body)) return null
  if (eventType === 'dev.zooid.approval_request') {
    const { verb, detail } = approvalAction(content)
    const who = nonEmptyString(agentName) ?? 'An agent'
    return clamp(`🔐 ${who} wants to ${verb}: ${detail} — react 👍/👎`)
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
 * order. A mirror group lists the entries of one prose gap: a new `tool_call_id`
 * appends one, and a later `tool_call_update` for the same id mutates that entry
 * in place (title/status/params/output) — never a duplicate. `params` is the
 * tool's compact ACP `rawInput` (the bash command, the edit filepath, …) and
 * `output` is the latest truncated text from its `tool_call_update` `content[]`.
 */
export interface TurnToolEntry {
  toolCallId: string
  title: string
  /** ACP `ToolCallStatus`: pending | in_progress | completed | failed. */
  status?: string
  /** Compact, single-line rendering of the tool's ACP `rawInput`, if seen. */
  params?: string
  /** Latest `tool_call_update` `content[]` text, clamped, `\n`-joined. */
  output?: string
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

/**
 * Emoji identifying a tool by its ACP title's first word (`bash`,
 * `edit src/x.ts`, `coolify_get_application`, `ssh_run-command`, …), so a long
 * list of taglines is scannable by shape rather than by reading every name.
 * Exact names win; a prefix fallback covers descriptive titles (`Reading
 * auth.ts`); anything else gets a generic marker. Icons sit between the status
 * glyph and the tool name (`✓ 📖 read — done`) and never replace either.
 */
const TOOL_ICON_BY_NAME: Record<string, string> = {
  read: '📖',
  view: '📖',
  open: '📖',
  edit: '✏️',
  write: '✏️',
  create: '✏️',
  update: '✏️',
  patch: '✏️',
  apply: '✏️',
  multiedit: '✏️',
  bash: '🐚',
  shell: '🐚',
  ssh: '🐚',
  exec: '🐚',
  terminal: '🐚',
  run: '🐚',
  grep: '🔍',
  search: '🔍',
  find: '🔍',
  ripgrep: '🔍',
  glob: '🗂',
  ls: '🗂',
  list: '🗂',
  dir: '🗂',
  todo: '📝',
  todowrite: '📝',
  fetch: '🌐',
  webfetch: '🌐',
  websearch: '🌐',
  download: '🌐',
  task: '🤖',
  skill: '🤖',
  agent: '🤖',
  subagent: '🤖',
  zooid: '💬',
  matrix: '💬',
  message: '💬',
  send: '💬',
  broadcast: '💬',
  coolify: '☁️',
  docker: '☁️',
  deploy: '☁️',
  github: '🐙',
  git: '🐙',
  truenas: '💾',
  zfs: '💾',
  storage: '💾',
  pocketid: '🔑',
  key: '🔑',
  secret: '🔑',
  ha: '🏠',
  hass: '🏠',
  homeassistant: '🏠',
}

/** Prefix fallback for descriptive titles (`Reading auth.ts`, `Editing notes`). */
const TOOL_ICON_PREFIX: [string, string][] = [
  ['read', '📖'],
  ['view', '📖'],
  ['edit', '✏️'],
  ['writ', '✏️'],
  ['creat', '✏️'],
  ['search', '🔍'],
  ['fetch', '🌐'],
  ['list', '🗂'],
]

const DEFAULT_TOOL_ICON = '🛠'

/** The identifying emoji for a tool title; one code point plus VS16 at most. */
export function toolIcon(title: string): string {
  const words = title.trim().toLowerCase().split(/[\s_./:-]+/)
  const head = words[0]
  if (head && TOOL_ICON_BY_NAME[head]) return TOOL_ICON_BY_NAME[head]!
  for (const [prefix, icon] of TOOL_ICON_PREFIX) {
    if (head && head.startsWith(prefix)) return icon
  }
  return DEFAULT_TOOL_ICON
}

/** Cap a single collapsed tool line so a long title stays glanceable. */
const TOOL_LINE_MAX = 200
/** Cap a tool's compact parameter rendering so a huge diff / command can't bloat the block. */
const TOOL_PARAM_MAX = 200
/** Cap a tool's latest output, both per `content[]` entry and per tool. */
const TOOL_OUTPUT_MAX = 200

/**
 * Horizontal rule between sections in the plain body: between a tool's params
 * and its output, and between consecutive tool sections. It is one literal line,
 * so Element X (which ignores `<details>` and shows the plain body) keeps a
 * visible separator; the HTML body instead uses separate `<pre><code>` blocks
 * and a bare `<br>`, and no longer emits this rule. The string still backs the
 * shared plain/HTML size accounting.
 */
const GROUP_DIVIDER = '────────────────'

/**
 * One rendered line of a group body: literal text, or a horizontal rule. Keeping
 * the rule as a distinct kind (rather than a sentinel string) lets the plain and
 * HTML renderers share one line list — text is `\n`-joined/`<br>`-joined and the
 * rule becomes `GROUP_DIVIDER`/`<hr>`.
 */
type GroupLine = { kind: 'text'; text: string } | { kind: 'divider' }

/** Blank line plus rule between consecutive tool sections, so each block is distinct. */
const TOOL_SEPARATOR: GroupLine[] = [
  { kind: 'text', text: '' },
  { kind: 'divider' },
]

/**
 * Compact one-line rendering of a tool entry: `✓ 🐚 bash — done`,
 * `⏳ ✏️ edit src/x.ts`, `✗ 📖 read — failed`. The status glyph comes first,
 * then the tool's identifying icon, then the title. Only the title and status
 * are shown on this line — the params and output are separate indented lines.
 * The status label appears only for terminal states (the ⏳/• glyphs already
 * convey in-flight/pending), and the whole line is clamped.
 */
export function toolEntryLine(entry: TurnToolEntry): string {
  const terminal = entry.status === 'completed' || entry.status === 'failed'
  const label = terminal ? ` — ${toolStatusLabel(entry.status)}` : ''
  const text = `${toolIcon(entry.title)} ${entry.title}${label}`
  return clamp(`${toolStatusIcon(entry.status)} ${text}`, TOOL_LINE_MAX)
}

/** Collapse a raw scalar/object value to one compact, whitespace-normalised fragment. */
function compactValue(v: unknown): string {
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim()
  if (v === null) return 'null'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/**
 * Compact, single-line rendering of an ACP `rawInput`: a scalar renders as
 * itself, an object as `key=value` pairs joined by `, `. Each value is
 * whitespace-collapsed and the whole string is clamped (`TOOL_PARAM_MAX`), so a
 * big bash command or an edit diff stays glanceable. `undefined` when there is
 * nothing to show.
 */
export function toolParamsText(rawInput: unknown): string | undefined {
  if (rawInput === undefined || rawInput === null) return undefined
  if (typeof rawInput === 'string') {
    const s = rawInput.trim()
    return s ? clamp(s, TOOL_PARAM_MAX) : undefined
  }
  if (typeof rawInput !== 'object') return String(rawInput)
  const parts = Array.isArray(rawInput)
    ? rawInput.map(compactValue)
    : Object.entries(rawInput as Record<string, unknown>).map(
        ([k, v]) => `${k}=${compactValue(v)}`,
      )
  return parts.length > 0 ? clamp(parts.join(', '), TOOL_PARAM_MAX) : undefined
}

/** Extract display text from one ACP `ToolCallContent` entry. */
function outputEntryText(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') return undefined
  const rec = item as Record<string, unknown>
  if (rec.type === 'content') {
    const block = rec.content as Record<string, unknown> | undefined
    return block && block.type === 'text' ? nonEmptyString(block.text) : undefined
  }
  if (rec.type === 'diff') {
    const path = nonEmptyString(rec.path)
    const text = nonEmptyString(rec.newText) ?? nonEmptyString(rec.oldText)
    return [path, text].filter(Boolean).join(': ') || undefined
  }
  if (rec.type === 'terminal') {
    const id = nonEmptyString(rec.terminalId)
    return id ? `terminal ${id}` : 'terminal'
  }
  return undefined
}

/**
 * Flatten a `tool_call_update` `content[]` into one display block: each entry is
 * collapsed and clamped (`TOOL_OUTPUT_MAX`), the entries are joined with `\n`,
 * and the joined block is clamped again so one tool can never contribute more
 * than `TOOL_OUTPUT_MAX` characters. `undefined` when nothing renderable is
 * present.
 */
export function toolOutputText(content: unknown): string | undefined {
  if (!Array.isArray(content) || content.length === 0) return undefined
  const parts: string[] = []
  for (const item of content) {
    const text = outputEntryText(item)
    if (text) parts.push(clamp(text, TOOL_OUTPUT_MAX))
  }
  if (parts.length === 0) return undefined
  const joined = parts.join('\n')
  return joined.length > TOOL_OUTPUT_MAX
    ? joined.slice(0, TOOL_OUTPUT_MAX - 1) + '…'
    : joined
}

/**
 * Cap the number of rendered tool entries in one group, and the total rendered
 * body. Each entry is itself clamped, but a run of many tool calls before the
 * next prose message would otherwise grow the notice without bound — and every
 * `m.replace` resends the full body, so a runaway turn can bloat the notice and,
 * if the homeserver rejects the oversize edit, freeze the line. The newest
 * activity is kept and the hidden remainder summarised as `… K more`.
 */
const GROUP_LINE_MAX = 20
/** Total rendered body budget, measured on the HTML-escaped lines, so both the plain and formatted bodies stay under it. */
const GROUP_CHAR_MAX = 8000

/**
 * The lines one tool contributes: its line, then its params and output. A rule
 * separates the input from the output when both are present, so the two are
 * never mistaken for one another.
 */
function toolSectionLines(entry: TurnToolEntry): GroupLine[] {
  const lines: GroupLine[] = [{ kind: 'text', text: toolEntryLine(entry) }]
  if (entry.params) lines.push({ kind: 'text', text: entry.params })
  if (entry.params && entry.output) lines.push({ kind: 'divider' })
  if (entry.output) {
    for (const l of entry.output.split('\n')) lines.push({ kind: 'text', text: l })
  }
  return lines
}

/** Render one group line for the plain body (`\n`-joined). */
function renderGroupLine(line: GroupLine): string {
  return line.kind === 'divider' ? GROUP_DIVIDER : line.text
}

/** Render one group line for the HTML body (`<br>`-joined; a rule becomes `<hr>`). */
function renderGroupLineHtml(line: GroupLine): string {
  return line.kind === 'divider' ? '<hr>' : escapeHtml(line.text)
}

/** The widest a rendered line can be, so the size budget covers both renderings. */
function groupLineSize(line: GroupLine): number {
  return Math.max(renderGroupLine(line).length, renderGroupLineHtml(line).length) + 1
}

/**
 * The newest entries that fit the entry-count (`GROUP_LINE_MAX`) and total-size
 * (`GROUP_CHAR_MAX`) caps, plus how many older entries were dropped. The newest
 * entry is always kept, even if it alone exceeds the size budget, so the tool
 * named in the summary can never vanish from the body.
 */
function selectGroupEntries(entries: TurnToolEntry[]): {
  shown: TurnToolEntry[]
  omitted: number
} {
  const shown: TurnToolEntry[] = []
  let used = 0
  // Charge every entry the separator too (over-estimating by one for the first),
  // so the inter-tool blank line + rule can never push the body over budget.
  const separatorSize = TOOL_SEPARATOR.reduce((n, l) => n + groupLineSize(l), 0)
  for (let i = entries.length - 1; i >= 0; i--) {
    if (shown.length >= GROUP_LINE_MAX) break
    const entry = entries[i]!
    const size = toolSectionLines(entry).reduce((n, l) => n + groupLineSize(l), separatorSize)
    if (used + size > GROUP_CHAR_MAX && shown.length > 0) break
    shown.push(entry)
    used += size
  }
  shown.reverse()
  return { shown, omitted: entries.length - shown.length }
}

/**
 * Summary line for one group: `🔧 <agent>: <N tools> — <icon> <last tool> — <status>`.
 * It is the plain body's first line and the HTML `<summary>`. The status label
 * is omitted when the last tool has no known status; a plan-only group reads
 * `🔧 <agent>: 0 tools — plan`.
 */
export function turnGroupSummary(
  agentId: string,
  entries: TurnToolEntry[],
  planDetail?: string,
): string {
  const n = entries.length
  const tools = `${n} tool${n === 1 ? '' : 's'}`
  const last = entries.at(-1)
  let detail: string
  if (last) {
    const label = toolStatusLabel(last.status)
    const title = `${toolIcon(last.title)} ${last.title}`
    detail = label ? `${title} — ${label}` : title
  } else {
    detail = planDetail ? 'plan' : 'working'
  }
  return clamp(`🔧 ${agentId}: ${tools} — ${detail}`, TOOL_LINE_MAX)
}

/** The body lines of one group (everything after the summary): sections, then plan. */
function turnGroupBodyLines(entries: TurnToolEntry[], planDetail?: string): GroupLine[] {
  const { shown, omitted } = selectGroupEntries(entries)
  const lines: GroupLine[] = []
  if (omitted > 0) lines.push({ kind: 'text', text: `… ${omitted} more` })
  shown.forEach((entry, i) => {
    if (i > 0) lines.push(...TOOL_SEPARATOR)
    lines.push(...toolSectionLines(entry))
  })
  if (planDetail) lines.push({ kind: 'text', text: `🗒 ${clamp(planDetail)}` })
  return lines
}

/**
 * The plain fallback for one run of tool/plan activity: the group summary
 * followed by one section per tool (the tool line, its compact params, a rule,
 * its truncated output) and the plan detail. Consecutive tool sections are
 * separated by a blank line and a rule, so each tool's block is visually
 * distinct; a rule also sits between a tool's params and its output. It
 * carries exactly the content the HTML block carries, `\n`-joined, because that
 * is what Element X and non-HTML clients show. The group is created on the first
 * activity after a prose message and edited in place as more tools run, so the
 * gap between two prose messages is exactly one notice (never one per tool).
 */
export function turnGroupBody(
  agentId: string,
  entries: TurnToolEntry[],
  planDetail?: string,
): string {
  return [
    { kind: 'text' as const, text: turnGroupSummary(agentId, entries, planDetail) },
    ...turnGroupBodyLines(entries, planDetail),
  ]
    .map(renderGroupLine)
    .join('\n')
}

/**
 * HTML for one tool inside a group: a nested collapsed `<details>` whose
 * `<summary>` (first child, no `open`) is the tool's one-line rendering
 * (`✓ 🐚 bash — done`, see `toolEntryLine`), and whose body is its params and its
 * output as two separate `<pre><code>` blocks — so the timeline shows a tool's
 * tagline and status and hides its input/output until the reader opens it.
 * Inside a block newlines are literal (`\n`), not `<br>`: the block preserves
 * them and keeps Element Web/Desktop spacing tight. A tool with only params or
 * only output gets a single block; a tool with neither has nothing to collapse
 * and renders as the bare line to avoid a dead disclosure triangle. Every
 * interpolated value is HTML-escaped.
 */
function toolSectionHtml(entry: TurnToolEntry): string {
  const summary = escapeHtml(toolEntryLine(entry))
  const blocks: string[] = []
  if (entry.params) blocks.push(`<pre><code>${escapeHtml(entry.params)}</code></pre>`)
  if (entry.output) blocks.push(`<pre><code>${escapeHtml(entry.output)}</code></pre>`)
  if (blocks.length === 0) return summary
  return `<details><summary>${summary}</summary>${blocks.join('')}</details>`
}

/**
 * HTML rendering of the same group for `org.matrix.custom.html`: one collapsible
 * `<details>` block whose `<summary>` (first child, no `open`) is the group
 * summary, and whose body lists one entry per tool — each entry itself a nested
 * `<details>` (see `toolSectionHtml`) that collapses the tool's input/output
 * behind its tagline and status. Entries are joined by a single `<br>`: with
 * every tool collapsible and its own block, a rule between them is redundant,
 * and the old blank-line + `<hr>` + blank-line was what made Element Web/Desktop
 * far airier than Element X's tight plain body. The plain body is unchanged (see
 * `turnGroupBody`), so clients that ignore `<details>` keep their dividers and
 * spacing. Every interpolated value is HTML-escaped.
 */
export function turnGroupHtml(
  agentId: string,
  entries: TurnToolEntry[],
  planDetail?: string,
): string {
  const summary = escapeHtml(turnGroupSummary(agentId, entries, planDetail))
  const { shown, omitted } = selectGroupEntries(entries)
  const parts: string[] = []
  if (omitted > 0) parts.push(`… ${omitted} more`)
  parts.push(...shown.map(toolSectionHtml))
  let body = parts.join('<br>')
  if (planDetail) {
    const plan = `🗒 ${escapeHtml(clamp(planDetail))}`
    body = body.length > 0 ? `${body}<br>${plan}` : plan
  }
  return `<details><summary>${summary}</summary>${body}</details>`
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
 * execution is clear. The plain `body` is the `\n`-joined fallback
 * (see `turnGroupBody`); when `formattedBody` is given it rides alongside as
 * `org.matrix.custom.html` (see `turnGroupHtml`) so clients that render HTML
 * show the entries on separate lines.
 */
export function turnMirrorNoticeContent(
  body: string,
  threadRoot: string,
  formattedBody?: string,
): {
  msgtype: string
  body: string
  [k: string]: unknown
} {
  const content: { msgtype: string; body: string; [k: string]: unknown } = {
    msgtype: 'm.notice',
    body,
    [TURN_MIRROR_MARKER]: true,
    'm.relates_to': { rel_type: 'm.thread', event_id: threadRoot },
  }
  if (formattedBody !== undefined) {
    content.format = 'org.matrix.custom.html'
    content.formatted_body = formattedBody
  }
  return content
}

/**
 * Content of an `m.replace` edit of an interleaved mirror line, used to mutate
 * one tool/task line in place as its status changes (never a duplicate). The
 * replacement relation rides in the top-level `m.relates_to`; the thread
 * relation goes in `m.new_content.m.relates_to` (MSC2676 + MSC3440) so Element
 * keeps the edited line inside its thread. The marker is repeated in
 * `m.new_content` because that is the content a client applies. When
 * `formattedBody` is given, the `org.matrix.custom.html` shape is repeated in
 * both the top-level fallback and `m.new_content`.
 */
export function turnMirrorEditContent(
  eventId: string,
  body: string,
  threadRoot: string,
  formattedBody?: string,
): {
  msgtype: string
  body: string
  [k: string]: unknown
} {
  const newContent: { msgtype: string; body: string; [k: string]: unknown } = {
    msgtype: 'm.notice',
    body,
    [TURN_MIRROR_MARKER]: true,
    'm.relates_to': { rel_type: 'm.thread', event_id: threadRoot },
  }
  const content: { msgtype: string; body: string; [k: string]: unknown } = {
    msgtype: 'm.notice',
    body: `* ${body}`,
    [TURN_MIRROR_MARKER]: true,
    'm.new_content': newContent,
    'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
  }
  if (formattedBody !== undefined) {
    newContent.format = 'org.matrix.custom.html'
    newContent.formatted_body = formattedBody
    content.format = 'org.matrix.custom.html'
    content.formatted_body = `* ${formattedBody}`
  }
  return content
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
