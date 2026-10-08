import { toolCallDiff } from './unified-diff.js'
export { toolCallDiff, DIFF_PARAM_KEYS } from './unified-diff.js'
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
  // The diff is computed from the *untruncated* input: raw_input is clamped to
  // RAW_INPUT_STR_MAX, and a diff built from a clamped oldString would be a
  // diff of the clamp, not of the change.
  const diff = toolCallDiff({ title: evt.title, raw_input: evt.rawInput })
  if (diff) out.diff = diff
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
  // The update's title is NOT forwarded into the body: it is not a stable tool
  // name. On the completed frame opencode replaces it with a runtime display
  // string (bash → the command, edit/write → the file path, todowrite →
  // "0 todos"), and `toolIcon` derives the tagline emoji from the title's first
  // word, so forwarding it makes bash/edit/write/todowrite fall back to 🛠.
  // The initial `tool_call` already set the entry's tool-name title; updates
  // must not overwrite it. The title is still passed to `toolCallDiff` below —
  // it is the only thing that tells a whole-file `write` apart from an in-place
  // `edit` (ACP has no `write` kind), and the in-progress frame carries the
  // tool name (`title: "write"`) exactly when the create fallback needs it.
  // content[] carries display-ready output (text/diff/terminal); rawOutput is
  // intentionally NOT serialized — it's typically large and duplicates content.
  if (evt.content !== undefined) out.content = evt.content
  // Some ACP agents only set rawInput on a later update (not the initial
  // tool_call). Truncate strings and forward.
  if (evt.rawInput !== undefined) out.raw_input = truncateStrings(evt.rawInput, RAW_INPUT_STR_MAX)
  if (evt.locations !== undefined) out.locations = evt.locations
  // See toToolCallBody: computed pre-truncation, and it prefers the update's
  // own diff content block over the raw input.
  const diff = toolCallDiff({
    title: evt.title,
    kind: evt.kind,
    raw_input: evt.rawInput,
    content: evt.content,
  })
  if (diff) out.diff = diff
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

/**
 * One preformatted block for `org.matrix.custom.html`. Newlines are literal
 * (`\n`), not `<br>`: the block preserves them, which keeps Element Web/Desktop
 * spacing tight. `language` adds a `class="language-…"` so clients can
 * highlight it — `language-diff` is what makes Element render a unified diff
 * as a diff. The text is HTML-escaped.
 */
function codeBlockHtml(text: string, language?: string): string {
  const cls = language ? ` class="${language}"` : ''
  return `<pre><code${cls}>${escapeHtml(text)}</code></pre>`
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
  /**
   * The tool's ACP `rawInput` as the mirror body carries it. `params` is derived
   * from this rather than accumulated, because a diff can arrive on a later
   * `tool_call_update` than the input that would have been filtered by it — the
   * stored input is what lets the params line be re-derived once the diff does.
   */
  rawInput?: unknown
  /** Latest `tool_call_update` `content[]` text, clamped, `\n`-joined. */
  output?: string
  /**
   * Unified diff of the file the call changed, when its input (or its update's
   * `content[]`) carries the old and the new text — see `toolCallDiff`. It
   * renders as its own `language-diff` block, and the keys it covers
   * (`DIFF_PARAM_KEYS`) are filtered out of `params` so the old and new text
   * appear once, in their readable form.
   */
  diff?: string
  /**
   * File the call reads or writes, from the ACP `rawInput` path keys or the
   * event's first `locations[].path` (see `toolEntryPath`). Read/write tools
   * show it instead of their tool name on the tagline.
   */
  path?: string
  /**
   * Machine the call ran on, from the ACP `rawInput` (`profile`, else `host` /
   * `hostname` — see `toolEntryMachine`). Never invented; shell tools without
   * one fall back to `local`.
   */
  machine?: string
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
 * Marker identifying a tool by its ACP title's first word (`bash`,
 * `edit src/x.ts`, `coolify_get_application`, `ssh_run-command`, …), so a long
 * list of taglines is scannable by shape rather than by reading every name.
 * Most are emoji; the shell family uses the literal `>_` prompt. Exact names
 * win; a prefix fallback covers descriptive titles (`Reading auth.ts`);
 * anything else gets a generic marker. Markers sit between the status glyph and
 * the tool name (`✓ 📖 read`) and never replace either.
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
  bash: '>_',
  shell: '>_',
  ssh: '>_',
  exec: '>_',
  terminal: '>_',
  run: '>_',
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
  // Code Mode (`execute`, listed first in the tagline) and its `code*` aliases:
  // a script glyph, because the call runs a script rather than reading, writing
  // or fetching (see `CODE_TOOL_HEADS`).
  execute: '📜',
  code: '📜',
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

/**
 * First word of a tool title, lowercased and split on the separators tool names
 * use (`github_get_file_contents` → `github`, `ha_GetDateTime` → `ha`,
 * `Read file` → `read`). It is the key the icon and the subject rules match on.
 */
function toolHead(title: string): string {
  return title.trim().toLowerCase().split(/[\s_./:-]+/)[0] ?? ''
}

/**
 * The identifying marker for a tool title: an emoji (one code point plus VS16
 * at most) or the literal two-character `>_` for shell tools.
 */
export function toolIcon(title: string): string {
  const head = toolHead(title)
  if (head && TOOL_ICON_BY_NAME[head]) return TOOL_ICON_BY_NAME[head]!
  for (const [prefix, icon] of TOOL_ICON_PREFIX) {
    if (head && head.startsWith(prefix)) return icon
  }
  return DEFAULT_TOOL_ICON
}

/**
 * Icon families whose tagline names the file (📖 readers, ✏️ writers). Kept in
 * step with `TOOL_ICON_BY_NAME`'s reader/writer entries — a tool's icon is what
 * marks it path-bearing.
 */
const PATH_TOOL_ICONS: ReadonlySet<string> = new Set(['📖', '✏️'])

/** Icon family whose calls run on a machine the tagline must name (bash/ssh). */
const SHELL_TOOL_ICON = '>_'

/**
 * Icon family whose tagline names the request URL (🌐 fetch/webfetch). A
 * websearch shares the globe but names its `query` instead (see
 * `WEB_SEARCH_HEADS`), so the globe alone reads as "went to the web" for both.
 */
const WEB_TOOL_ICON = '🌐'

/** Tool heads that are web searches: their subject is the query, not a URL. */
const WEB_SEARCH_HEADS: ReadonlySet<string> = new Set(['websearch', 'web_search', 'web-search'])

/** Raw-input keys that carry a web search query. */
const RAW_INPUT_QUERY_KEYS = ['query', 'q', 'search_query', 'searchQuery']

/**
 * Machine label for a shell call whose ACP event carries none: bash/ssh tools
 * run inside the agent container unless their input names a profile or a host,
 * and inventing a hostname would be a lie. No zooid config names this machine,
 * so the honest label is `local`.
 */
const LOCAL_MACHINE = 'local'

/** Cap a machine label so one long host value can't eat the line. */
const MACHINE_MAX = 40

/** Path-ish keys an ACP `rawInput` uses to name the file a tool touches. */
const RAW_INPUT_PATH_KEYS = ['filePath', 'filepath', 'file_path', 'path']

/** Machine-ish keys an ACP `rawInput` uses to name where a call runs. */
const RAW_INPUT_MACHINE_KEYS = ['profile', 'host', 'hostname']

/** URL key an ACP `rawInput` uses for a web request. */
const RAW_INPUT_URL_KEYS = ['url']

/** Command key an ACP `rawInput` uses for a shell call. */
const RAW_INPUT_COMMAND_KEYS = ['command']

/** First non-empty string among `keys` of a raw object; `undefined` when absent. */
function firstString(obj: unknown, keys: readonly string[]): string | undefined {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined
  const rec = obj as Record<string, unknown>
  for (const key of keys) {
    const value = nonEmptyString(rec[key])
    if (value) return value
  }
  return undefined
}

/**
 * File for a tagline: the first path-ish string in the event's `raw_input`
 * (`filePath`/`filepath`/`file_path`/`path`), else the first `locations[].path`
 * (some agents only report the file there). `undefined` when the tool names no
 * file — the tagline then falls back to the tool's title.
 */
export function toolEntryPath(content: Record<string, unknown>): string | undefined {
  const fromInput = firstString(content.raw_input, RAW_INPUT_PATH_KEYS)
  if (fromInput) return fromInput
  const locations = content.locations
  if (Array.isArray(locations)) {
    for (const loc of locations) {
      const path = nonEmptyString((loc as { path?: unknown } | null | undefined)?.path)
      if (path) return path
    }
  }
  return undefined
}

/**
 * Machine a call ran on, from the event's `raw_input`: the ssh-mcp `profile`
 * first (coolify, router, hass, …), then `host` / `hostname`. `undefined` when
 * the event names none — only shell tools then fall back to `local`
 * (see `toolSubject`); nothing is ever guessed.
 */
export function toolEntryMachine(content: Record<string, unknown>): string | undefined {
  const machine = firstString(content.raw_input, RAW_INPUT_MACHINE_KEYS)
  return machine ? clamp(machine, MACHINE_MAX) : undefined
}

/** A raw input seen as a plain object; `undefined` for scalar, array or absent input. */
function rawObject(raw: unknown): Record<string, unknown> | undefined {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined
}

/** A non-empty string, or a finite number rendered as one (a raw arg may be numeric). */
function scalarString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/**
 * A picked value plus the raw-input key it came from. Carrying the key lets the
 * params block drop an argument the tagline already names — see
 * `toolSubjectParamKeys`.
 */
interface Picked {
  text: string
  keys: string[]
}

/** First non-empty string/number among `keys`, with the key that provided it. */
function pickKey(raw: Record<string, unknown>, ...keys: readonly string[]): Picked | undefined {
  for (const key of keys) {
    const value = scalarString(raw[key])
    if (value) return { text: value, keys: [key] }
  }
  return undefined
}

/** First non-empty *string* among `keys`, with its key (the ACP string-field semantics). */
function pickStringKey(
  raw: Record<string, unknown>,
  ...keys: readonly string[]
): Picked | undefined {
  for (const key of keys) {
    const value = nonEmptyString(raw[key])
    if (value) return { text: value, keys: [key] }
  }
  return undefined
}

/** The first raw-input key whose value is a non-empty string, for params-dedup. */
function firstStringKey(obj: unknown, keys: readonly string[]): string | undefined {
  const raw = rawObject(obj)
  if (!raw) return undefined
  for (const key of keys) {
    if (nonEmptyString(raw[key])) return key
  }
  return undefined
}

/** The `raw_input` key a machine suffix came from (`profile`/`host`/`hostname`). */
function machineKeys(rawInput: unknown): string[] {
  const key = firstStringKey(rawInput, RAW_INPUT_MACHINE_KEYS)
  return key ? [key] : []
}

/** `owner/repo`, or whichever half the input names. */
function repoOf(raw: Record<string, unknown>): Picked | undefined {
  const owner = pickKey(raw, 'owner')
  const repo = pickKey(raw, 'repo', 'repository')
  if (owner && repo) {
    return { text: `${owner.text}/${repo.text}`, keys: [...owner.keys, ...repo.keys] }
  }
  return repo ?? owner
}

// ── Family subject extractors ────────────────────────────────────────────────
// A tool title says *what kind* of call it was (`github_get_file_contents`); the
// icon already says which family (🐙). These pick the one argument from the ACP
// `rawInput` that says *what it acted on*, so a tagline reads
// `🐙 github_get_file_contents MarioCakeDev/zooid:src/x.ts` instead of stopping
// at the bare tool name. Each returns `undefined` when the call carries nothing
// to name, and the tagline then falls back to the title alone.

/** A GitHub call: search query, `repo:path`, `repo#number`, `repo@ref`, a PR head→base, a branch, or just `owner/repo`. */
function githubSubject(raw: Record<string, unknown>): Picked | undefined {
  const query = pickKey(raw, 'query')
  if (query) return query
  const repo = repoOf(raw)
  const path = pickKey(raw, 'path', 'filePath', 'file_path', 'filepath')
  if (path) {
    return repo ? { text: `${repo.text}:${path.text}`, keys: [...repo.keys, ...path.keys] } : path
  }
  const number = pickKey(raw, 'issue_number', 'pullNumber', 'pull_number', 'number')
  if (number) {
    return repo
      ? { text: `${repo.text}#${number.text}`, keys: [...repo.keys, ...number.keys] }
      : number
  }
  const ref = pickKey(raw, 'sha', 'tag', 'ref')
  if (ref) {
    return repo
      ? { text: `${repo.text}@${ref.text.slice(0, 12)}`, keys: [...repo.keys, ...ref.keys] }
      : ref
  }
  const head = pickKey(raw, 'head')
  if (head) {
    if (!repo) return head
    const base = pickKey(raw, 'base')
    return {
      text: `${repo.text} ${head.text}→${base?.text ?? '?'}`,
      keys: [...repo.keys, ...head.keys, ...(base?.keys ?? [])],
    }
  }
  const branch = pickKey(raw, 'branch')
  if (repo) {
    return branch
      ? { text: `${repo.text}@${branch.text}`, keys: [...repo.keys, ...branch.keys] }
      : repo
  }
  if (branch) return branch
  const org = pickKey(raw, 'org')
  const team = pickKey(raw, 'team_slug')
  if (org && team) return { text: `${org.text}/${team.text}`, keys: [...org.keys, ...team.keys] }
  if (org) return org
  return pickKey(raw, 'user', 'name', 'comment_id')
}

/** A Coolify call: the resource UUID (with the sub-container when logs name one, or the tag names for a tag call), else id/query/name/key, else the action plus its resource/provider. */
function coolifySubject(raw: Record<string, unknown>): Picked | undefined {
  const tags = Array.isArray(raw.tag_names)
    ? raw.tag_names.filter((t): t is string => typeof t === 'string' && t.length > 0)
    : []
  if (tags.length > 0) return { text: tags.join(','), keys: ['tag_names'] }
  const uuid = pickKey(
    raw,
    'tag_or_uuid',
    'uuid',
    'database_uuid',
    'backup_uuid',
    'execution_uuid',
    'storage_uuid',
    'task_uuid',
    'tag_uuid',
    'application_uuid',
    'project_uuid',
  )
  if (uuid) {
    const container = pickKey(raw, 'container')
    if (container) {
      return { text: `${uuid.text}/${container.text}`, keys: [...uuid.keys, ...container.keys] }
    }
    const key = pickKey(raw, 'key')
    if (key) return { text: `${uuid.text}:${key.text}`, keys: [...uuid.keys, ...key.keys] }
    return uuid
  }
  const direct = pickKey(raw, 'id', 'query', 'name', 'key', 'mount_path', 'command')
  if (direct) return direct
  const action = pickKey(raw, 'action')
  const detail = pickKey(raw, 'resource') ?? pickKey(raw, 'provider')
  if (!action) return undefined
  return {
    text: [action.text, detail?.text].filter(Boolean).join(' '),
    keys: [...action.keys, ...(detail?.keys ?? [])],
  }
}

/** A TrueNAS call: the dataset/snapshot it names, else user, share, pool or id. */
function truenasSubject(raw: Record<string, unknown>): Picked | undefined {
  return pickKey(
    raw,
    'dataset',
    'snapshot',
    'username',
    'name',
    'share_name',
    'path',
    'pool',
    'pool_name',
    'target',
    'id',
  )
}

/** A Pocket ID call: the entity id/name/username it acts on. */
function pocketidSubject(raw: Record<string, unknown>): Picked | undefined {
  return pickKey(
    raw,
    'id',
    'name',
    'username',
    'email',
    'displayName',
    'friendlyName',
    'search',
    'userGroupId',
    'oidcClientId',
    'userId',
    'clientId',
    'endpoint',
    'appName',
  )
}

/** A Home Assistant call: the entity name, else area, list item, entity_id, floor, message, media query, reported health observation or todo list. */
function haSubject(raw: Record<string, unknown>): Picked | undefined {
  return pickKey(
    raw,
    'name',
    'area',
    'item',
    'entity_id',
    'floor',
    'message',
    'search_query',
    'beschreibung',
    'todo_list',
    'kategorie',
  )
}

/** A zooid/Matrix call: the room or thread it targets, else a name or the message text. */
function zooidSubject(raw: Record<string, unknown>): Picked | undefined {
  return pickKey(raw, 'room', 'thread_id', 'name', 'text')
}

/** An ssh-mcp call with no command: the signal+pid, path, session name or profile it acts on. */
function sshSubject(raw: Record<string, unknown>): Picked | undefined {
  const pid = pickKey(raw, 'pid')
  if (pid) {
    const signal = pickKey(raw, 'signal')
    return signal
      ? { text: `${signal.text} ${pid.text}`, keys: [...signal.keys, ...pid.keys] }
      : pid
  }
  return pickKey(raw, 'remotePath', 'localPath', 'path', 'name')
}

/** A grep/glob pattern. */
function patternSubject(raw: Record<string, unknown>): Picked | undefined {
  return pickKey(raw, 'pattern', 'query')
}

/** A todowrite list length (`3 todos`), when the input carries the list. */
function todoSubject(raw: Record<string, unknown>): Picked | undefined {
  const todos = raw.todos
  if (!Array.isArray(todos)) return undefined
  return { text: `${todos.length} todo${todos.length === 1 ? '' : 's'}`, keys: ['todos'] }
}

/** A task's description/prompt. */
function descriptionSubject(raw: Record<string, unknown>): Picked | undefined {
  return pickKey(raw, 'description', 'prompt')
}

/** A skill name. */
function skillSubject(raw: Record<string, unknown>): Picked | undefined {
  return pickKey(raw, 'name', 'skill')
}

/**
 * Family prefixes stripped from a tool title before its verb is shown, longest
 * first so `zooid-context_zooid_` wins over the shorter forms. The icon already
 * names the family, so `github_get_file_contents` reads as `get_file_contents`.
 *
 * `zooid-context` is not listed here: its ACP server name is unique per spawn
 * (`zooid-context-<spawnId>`, see `contextServerName`), so it is matched by the
 * regex below rather than a fixed literal.
 */
const TOOL_NAME_FAMILIES: readonly string[] = [
  'github_',
  'coolify_',
  'truenas_',
  'pocketid_',
  'ssh_',
  'ha_',
]

/** `zooid-context_` or the per-spawn `zooid-context-<spawnId>_` form. */
const ZOOID_CONTEXT_PREFIX = /^zooid-context(?:-[^_]+)?_/i

/** A tool title with its family prefix removed (`github_deploy` → `deploy`). */
function toolShortName(title: string): string {
  const context = title.match(ZOOID_CONTEXT_PREFIX)
  if (context) {
    const rest = title.slice(context[0].length)
    return rest.toLowerCase().startsWith('zooid_') ? rest.slice('zooid_'.length) : rest
  }
  const lower = title.toLowerCase()
  for (const prefix of TOOL_NAME_FAMILIES) {
    if (lower.startsWith(prefix)) return title.slice(prefix.length)
  }
  return title
}

/**
 * Per-family subject extraction, keyed by the tool title's first word. `verb`
 * keeps the tool's specific verb before the extracted argument (family prefix
 * stripped): the github/coolify/… icons cover dozens of verbs, so
 * `deploy <uuid>` must still say `deploy`. The search/todo rules show the
 * extracted fact alone, because `🔍 <pattern>` and `📝 3 todos` already read as
 * the action.
 */
interface ToolSubjectRule {
  heads: readonly string[]
  pick: (raw: Record<string, unknown>) => Picked | undefined
  verb: boolean
}

const TOOL_SUBJECT_RULES: readonly ToolSubjectRule[] = [
  { heads: ['github'], pick: githubSubject, verb: true },
  { heads: ['coolify'], pick: coolifySubject, verb: true },
  { heads: ['truenas'], pick: truenasSubject, verb: true },
  { heads: ['pocketid'], pick: pocketidSubject, verb: true },
  { heads: ['ha'], pick: haSubject, verb: true },
  { heads: ['zooid'], pick: zooidSubject, verb: true },
  { heads: ['ssh'], pick: sshSubject, verb: true },
  { heads: ['grep'], pick: patternSubject, verb: false },
  { heads: ['glob'], pick: patternSubject, verb: false },
  { heads: ['todowrite', 'todo'], pick: todoSubject, verb: false },
  { heads: ['task'], pick: descriptionSubject, verb: true },
  { heads: ['skill'], pick: skillSubject, verb: true },
]

/** The family rule for a tool title, if one matches its first word. */
function toolRuleSubject(entry: TurnToolEntry): Picked | undefined {
  const head = toolHead(entry.title)
  const rule = TOOL_SUBJECT_RULES.find((r) => r.heads.includes(head))
  if (!rule) return undefined
  const raw = rawObject(entry.rawInput)
  const detail = raw ? rule.pick(raw) : undefined
  if (!rule.verb) return detail
  const verb = toolShortName(entry.title)
  if (!detail) return { text: verb, keys: [] }
  return { text: `${verb} ${detail.text}`, keys: detail.keys }
}

/**
 * The subject a tagline names, resolved once for both the rendered line and the
 * params-dedup. `text` is what follows the icon; `keys` are the raw-input keys
 * it already shows (so the params block can drop them, see
 * `toolSubjectParamKeys`); `machine` is the `@machine` suffix; and
 * `commandFirst` puts that suffix before a shell command
 * (`>_ @coolify docker ps`) rather than after a subject.
 */
interface ResolvedSubject {
  text: string
  keys: string[]
  machine?: string
  commandFirst: boolean
}

function resolveSubject(entry: TurnToolEntry): ResolvedSubject {
  const icon = toolIcon(entry.title)
  const isShell = icon === SHELL_TOOL_ICON
  const machine = entry.machine ?? (isShell ? LOCAL_MACHINE : undefined)
  const raw = rawObject(entry.rawInput) ?? {}
  const mKeys = machineKeys(entry.rawInput)
  const done = (text: string, keys: string[], commandFirst = false): ResolvedSubject => ({
    text,
    // The machine key is derived from `raw_input`, not `entry.machine`: params
    // are computed before `entry.machine` is assigned, but whenever the input
    // names a machine the transport fills it in and the tagline shows it, so
    // the key must always be dropped.
    keys: [...keys, ...mKeys],
    machine,
    commandFirst,
  })

  if (WEB_SEARCH_HEADS.has(toolHead(entry.title))) {
    const query = pickStringKey(raw, ...RAW_INPUT_QUERY_KEYS)
    return done(query ? query.text : entry.title, query?.keys ?? [])
  }
  if (icon === WEB_TOOL_ICON) {
    const url = pickStringKey(raw, ...RAW_INPUT_URL_KEYS)
    if (url) return done(url.text, url.keys)
  }
  if (isShell) {
    const command = pickStringKey(raw, ...RAW_INPUT_COMMAND_KEYS)
    // Collapse a multi-line command so the tagline stays one line; a
    // whitespace-only command collapses to nothing and falls through to the
    // rule/title rather than showing a blank subject.
    const oneLine = command?.text.replace(/\s+/g, ' ').trim()
    if (command && oneLine) return done(oneLine, command.keys, true)
  }
  const rule = toolRuleSubject(entry)
  if (rule) return done(rule.text, rule.keys)
  if (PATH_TOOL_ICONS.has(icon)) {
    const pathKey = firstStringKey(entry.rawInput, RAW_INPUT_PATH_KEYS)
    const named = entry.path ?? (pathKey ? nonEmptyString(raw[pathKey]) : undefined)
    if (named) return done(named, pathKey ? [pathKey] : [])
  }
  return done(entry.title, [])
}

/**
 * The raw-input keys a tool's tagline already shows, so callers can drop them
 * from the params block below it (an argument named twice is noise). Includes
 * the machine key when the tagline carries a `@machine` suffix.
 */
export function toolSubjectParamKeys(entry: TurnToolEntry): ReadonlySet<string> {
  return new Set(resolveSubject(entry).keys)
}

/**
 * Overhead of a rendered line around its subject: the status glyph (≤ 2 UTF-16
 * units) plus the two spaces around the icon (≤ 2 units), padded so the subject
 * budget can never overshoot `TOOL_LINE_MAX`.
 */
const SUBJECT_OVERHEAD = 6

/**
 * What a tagline talks about — `icon + named + @machine`:
 * `>_ @local pnpm -r build`, `📖 /workspace/AGENTS.md`,
 * `✏️ /workspace/src/x.ts`, `🌐 https://example.com`,
 * `🌐 zooid websocket docs`, `🐙 github_get_file_contents owner/repo:src/x.ts`.
 * The *named* part is tried in this order: the search query for a web search
 * (the globe says it was a search, so the keywords say the rest), the request
 * URL for a 🌐 web fetch, a family subject for a GitHub/Coolify/TrueNAS/Pocket
 * ID/HA/zooid/ssh/grep/glob/todo/task/skill call (see `toolRuleSubject`), the
 * file path for a read/write tool, the executed command for a shell call, the
 * title otherwise. A machine ` @<profile|host>` rides along whenever the call
 * names one, and shell tools that name none get ` @local`, so every bash/ssh
 * line says where it ran. For a shell call that carries a command the machine
 * sits right after the icon, before the command (`>_ @local pnpm test`); a shell
 * call with no command keeps the title and a trailing machine
 * (`>_ bash @local`). Read/write and web tools normally carry no suffix — they
 * run in the agent container, so the path or URL is the useful half of the line.
 *
 * `lineMax` is what the whole line may use; the head is clamped to what is left
 * after the icon and the suffix, so a long path or command can never push the
 * machine off the end of a clamped line.
 */
function toolSubject(entry: TurnToolEntry, lineMax = TOOL_LINE_MAX): string {
  const icon = toolIcon(entry.title)
  const { text, machine, commandFirst } = resolveSubject(entry)
  const suffix = machine ? ` @${machine}` : ''
  const budget = lineMax - icon.length - suffix.length - SUBJECT_OVERHEAD
  const head = text.length > budget ? text.slice(0, Math.max(1, budget - 1)) + '…' : text
  // A shell command puts the machine before it (`>_ @coolify docker ps`); every
  // other subject puts the machine after (`>_ bash @local`).
  return commandFirst ? `${icon}${suffix} ${head}` : `${icon} ${head}${suffix}`
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
 * Compact one-line rendering of a tool entry: `✓ >_ bash @local`,
 * `⏳ ✏️ /workspace/src/x.ts`, `✗ 📖 /workspace/AGENTS.md`. The status glyph
 * comes first and carries the status on its own — ✓ done, ✗ failed, ⏳ running,
 * • pending — so no status word is repeated in the line. Then the tool's
 * identifying icon and its subject: the file path for a read/write tool that
 * named one, the title otherwise, plus the machine for shell calls
 * (see `toolSubject`). Params and output are separate indented lines; the whole
 * line is clamped.
 */
export function toolEntryLine(entry: TurnToolEntry): string {
  return clamp(`${toolStatusIcon(entry.status)} ${toolSubject(entry)}`, TOOL_LINE_MAX)
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
 *
 * `omit` drops named keys — the caller passes `DIFF_PARAM_KEYS` when the call
 * renders a diff, so the keys the diff already shows are not repeated here
 * while the rest (`replace_all`, `filePath`, …) still are.
 */
export function toolParamsText(
  rawInput: unknown,
  omit?: ReadonlySet<string>,
): string | undefined {
  if (rawInput === undefined || rawInput === null) return undefined
  if (typeof rawInput === 'string') {
    const s = rawInput.trim()
    return s ? clamp(s, TOOL_PARAM_MAX) : undefined
  }
  if (typeof rawInput !== 'object') return String(rawInput)
  const parts = Array.isArray(rawInput)
    ? rawInput.map(compactValue)
    : Object.entries(rawInput as Record<string, unknown>)
        .filter(([k]) => !omit?.has(k))
        .map(([k, v]) => `${k}=${compactValue(v)}`)
  return parts.length > 0 ? clamp(parts.join(', '), TOOL_PARAM_MAX) : undefined
}

/**
 * Code-Mode tool heads whose raw `code` is rendered verbatim. The Code Mode
 * `execute` tool carries its whole script as a single `code` argument; collapsing
 * and clamping it like an ordinary param (`code=…`, capped at `TOOL_PARAM_MAX`)
 * hides the one thing the call is about, so a dedicated block shows it in full
 * instead. `code` also matches names like `code_mode_execute` — `toolHead`
 * splits on `_`.
 */
const CODE_TOOL_HEADS: ReadonlySet<string> = new Set(['execute', 'code'])

/**
 * The verbatim `code` of a Code-Mode tool call, or `undefined` for any other
 * tool (and for a code tool whose input carries no string `code`). Unlike
 * `compactValue`, whitespace and newlines are preserved — the code renders as
 * its own multi-line block, never collapsed and never clamped.
 */
export function toolCodeText(entry: TurnToolEntry): string | undefined {
  if (!CODE_TOOL_HEADS.has(toolHead(entry.title))) return undefined
  const raw = rawObject(entry.rawInput)
  return raw ? nonEmptyString(raw.code) : undefined
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
 * never mistaken for one another. `params` and `diff` are both shown when both
 * are set: the params line has the diff's own keys filtered out (see
 * `DIFF_PARAM_KEYS`), so it carries only what the diff does not.
 */
function toolSectionLines(entry: TurnToolEntry): GroupLine[] {
  const lines: GroupLine[] = [{ kind: 'text', text: toolEntryLine(entry) }]
  if (entry.params) lines.push({ kind: 'text', text: entry.params })
  if (entry.diff) {
    for (const l of entry.diff.split('\n')) lines.push({ kind: 'text', text: l })
  }
  if ((entry.params || entry.diff) && entry.output) lines.push({ kind: 'divider' })
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
 * Summary line for one group: `🔧 <agent>: <N tools> — <icon> <last tool>`.
 * It is the plain body's first line and the HTML `<summary>`. The last tool is
 * named exactly as its tagline names it (path for a read/write tool, machine
 * for a shell call) minus the status glyph — the status word is gone from the
 * mirror entirely, and a plan-only group reads `🔧 <agent>: 0 tools — plan`.
 */
export function turnGroupSummary(
  agentId: string,
  entries: TurnToolEntry[],
  planDetail?: string,
): string {
  const n = entries.length
  const tools = `${n} tool${n === 1 ? '' : 's'}`
  const last = entries.at(-1)
  const prefix = `🔧 ${agentId}: ${tools} — `
  // The last tool gets only what the line has left after the prefix, so its
  // machine suffix survives the clamp too.
  const detail = last
    ? toolSubject(last, TOOL_LINE_MAX - prefix.length)
    : planDetail
      ? 'plan'
      : 'working'
  return clamp(`${prefix}${detail}`, TOOL_LINE_MAX)
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
 * (`✓ >_ bash @local`, see `toolEntryLine`), and whose body is its params and its
 * output as two separate `<pre><code>` blocks — so the timeline shows a tool's
 * tagline (its status glyph first) and hides its input/output until the reader
 * opens it.
 * Inside a block newlines are literal (`\n`), not `<br>`: the block preserves
 * them and keeps Element Web/Desktop spacing tight. A tool with only params or
 * only output gets a single block; a tool with neither has nothing to collapse
 * and renders as the bare line to avoid a dead disclosure triangle. Every
 * interpolated value is HTML-escaped.
 */
function toolSectionHtml(entry: TurnToolEntry): string {
  const summary = escapeHtml(toolEntryLine(entry))
  const blocks: string[] = []
  // A change renders as a language-diff code block: Element Web/Desktop colour
  // the -/+ lines, Element X shows it monospaced. Either way it reads as a diff.
  // The params line comes first and holds only what the diff omits.
  if (entry.params) blocks.push(codeBlockHtml(entry.params))
  if (entry.diff) blocks.push(codeBlockHtml(entry.diff, 'language-diff'))
  if (entry.output) blocks.push(codeBlockHtml(entry.output))
  if (blocks.length === 0) return summary
  return `<details><summary>${summary}</summary>${blocks.join('')}</details>`
}

/**
 * HTML rendering of the same group for `org.matrix.custom.html`: one collapsible
 * `<details>` block whose `<summary>` (first child, no `open`) is the group
 * summary, and whose body lists one entry per tool — each entry itself a nested
 * `<details>` (see `toolSectionHtml`) that collapses the tool's input/output
 * behind its tagline. Entries are joined by a single `<br>`: with
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

/**
 * A tappable Matrix permalink to one event. `serverName` rides as `via` so a
 * federated client knows which server to ask. `encodeURIComponent` turns the
 * sigil-heavy Matrix ids (`!`/`$`/`:`) into their percent-encoded form.
 */
export function matrixEventPermalink(
  roomId: string,
  eventId: string,
  serverName: string,
): string {
  return (
    `https://matrix.to/#/${encodeURIComponent(roomId)}/${encodeURIComponent(eventId)}` +
    `?via=${encodeURIComponent(serverName)}`
  )
}

/**
 * Content of the opt-in top-level thread completion notice: one short line
 * mentioning the author of the thread root, plus a link to the thread's latest
 * message. `m.text` (not `m.notice`) so the mention actually notifies — the
 * point is to tell the thread owner the thread ended. `m.mentions` carries the
 * root author so Element renders the MXID pill; the raw MXID also rides in
 * both `body` and `formatted_body`.
 *
 * The message is top-level rather than threaded (that is the whole point), so
 * it carries `COMPLETION_NOTICE_MARKER` for `route()` to drop: without it the
 * mention would wake an agent (or a `trigger: any` sibling) and loop.
 */
export const COMPLETION_NOTICE_MARKER = 'dev.zooid.completion_notice'

export function threadCompletionContent(input: {
  agentId: string
  summary: string
  permalink: string
  mentionUserId: string
  failed: boolean
}): { msgtype: string; body: string; format: string; formatted_body: string; [k: string]: unknown } {
  const marker = input.failed ? '⚠️' : '✅'
  const outcome = input.failed ? 'failed' : 'finished'
  const summary = input.summary.trim()
  const body =
    `${marker} ${input.agentId} ${outcome}` +
    (summary ? ` — ${summary}` : '') +
    `\n${input.mentionUserId}: ${input.permalink}`
  const formattedBody =
    `${marker} ${escapeHtml(input.agentId)} ${outcome}` +
    (summary ? ` — ${escapeHtml(summary)}` : '') +
    `<br>${escapeHtml(input.mentionUserId)}: ` +
    `<a href="${escapeHtml(input.permalink)}">Open thread ↗</a>`
  return {
    msgtype: 'm.text',
    body,
    format: 'org.matrix.custom.html',
    formatted_body: formattedBody,
    'm.mentions': { user_ids: [input.mentionUserId] },
    [COMPLETION_NOTICE_MARKER]: true,
  }
}

/**
 * Collapse arbitrary turn prose into the one-line summary a completion notice
 * carries: whitespace squeezed, length capped on a word boundary where one is
 * available inside the cap.
 */
export function completionSummary(text: string | undefined, max = 140): string {
  if (!text) return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}
