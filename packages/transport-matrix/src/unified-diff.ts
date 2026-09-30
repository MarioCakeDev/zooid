/**
 * Minimal unified-diff generator for the Element mirror.
 *
 * There is no MSC (and no client hook) that renders a diff in a stock Matrix
 * client, so the portable rendering is a *unified diff in a code block*:
 * `<pre><code class="language-diff">` for `org.matrix.custom.html` and the same
 * text in the plain `body` for Element X, notifications and anything else that
 * ignores HTML. Both clients then read it as a diff — Element Web/Desktop
 * highlight the `-`/`+` lines, Element X shows them monospaced — and neither
 * needs a feature the other lacks.
 *
 * Kept dependency-free and small on purpose: the mirror only needs the
 * old/new text a tool already hands us (`oldString`/`newString`, an ACP
 * `content[]` `diff` entry), and a linear-space LCS over line arrays is enough
 * for a file-sized edit. Very large inputs fall back to a single
 * replace-everything hunk rather than burning time on the DP table.
 */

/** Lines of unchanged context kept on each side of a change. */
const CONTEXT = 3

/**
 * Cap the generated diff so one large edit cannot eat the mirror body's
 * character budget (see `GROUP_CHAR_MAX` in the encoder). Roughly a screenful
 * of a code block; the tail is replaced by a `… +N lines` marker.
 */
export const DIFF_MAX = 1200

/**
 * Above this many lines on either side the LCS table is skipped and the change
 * is rendered as one whole-block replacement. The table is O(n·m), and a
 * mirror line is a glance, not a review tool — a coarse diff of a 50k-line
 * reformat is still readable, an O(n²) stall in the send path is not.
 */
const LCS_MAX_LINES = 4000

/**
 * Old-side header for a file that did not exist before: git's own convention,
 * and the only case where the mirror can honestly say so (the caller passes no
 * old text at all, versus an empty old file, which is an overwrite).
 */
const DEV_NULL = '/dev/null'

/**
 * Old/new key pairs an ACP `rawInput` uses to name the text a call replaces.
 * Order matters only for readability; the first pair present wins.
 */
const OLD_NEW_KEY_PAIRS: [string, string][] = [
  ['oldString', 'newString'],
  ['old_string', 'new_string'],
  ['oldText', 'newText'],
  ['old', 'new'],
]

/**
 * Key an ACP `rawInput` uses for the whole new content of a written file, when
 * it carries no old side. Reached only for a `CREATE_TITLES` tool (see there),
 * so `--- /dev/null` is the honest old side: the file did not exist before.
 */
const NEW_CONTENT_KEYS = ['content', 'newContent', 'new_content', 'text']

/**
 * Tool titles whose input may be a whole-file *creation*. Only a tool that
 * writes a file outright qualifies, because this fallback has no old side: the
 * diff it produces reads `--- /dev/null`, which claims the file did not exist
 * before. An in-place tool (`edit`, `update`, `patch`, `apply`, `multiedit`,
 * `apply_patch`) is excluded — its `content` key is the new text of a file that
 * is already there, and rendering it as a creation would be a lie. Those tools
 * still diff through `OLD_NEW_KEY_PAIRS`, which carries the real old text; when
 * they carry none, they get no diff rather than a fabricated one.
 */
const CREATE_TITLES: ReadonlySet<string> = new Set(['write', 'create'])

/** First word of a tool title, lower-cased (`write src/x.ts` → `write`). */
function titleHead(title: unknown): string | undefined {
  if (typeof title !== 'string') return undefined
  return title.trim().toLowerCase().split(/[\s_./:-]+/)[0]
}

interface DiffLine {
  kind: 'ctx' | 'del' | 'add'
  text: string
}

/** Split text into diff lines, dropping one trailing newline (a file's last `\n`). */
function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * The line-level edit script between `oldLines` and `newLines` as
 * `[kind, text]` pairs: the common lines in order, with the removed block
 * before the added one at each change point.
 *
 * Classic LCS by dynamic programming, then a walk that emits the script. When
 * the inputs are too large for the table it degrades to "delete everything,
 * add everything" — one hunk, correct, coarse.
 */
function editScript(oldLines: string[], newLines: string[]): DiffLine[] {
  const coarse = (): DiffLine[] => [
    ...oldLines.map((text): DiffLine => ({ kind: 'del', text })),
    ...newLines.map((text): DiffLine => ({ kind: 'add', text })),
  ]
  const n = oldLines.length
  const m = newLines.length
  if (n === 0) return newLines.map((text): DiffLine => ({ kind: 'add', text }))
  if (m === 0) return oldLines.map((text): DiffLine => ({ kind: 'del', text }))
  if (n + m > LCS_MAX_LINES) return coarse()

  // lcs[i][j] = length of the longest common subsequence of oldLines[i..] and
  // newLines[j..].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        oldLines[i] === newLines[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }

  const script: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      script.push({ kind: 'ctx', text: oldLines[i]! })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      script.push({ kind: 'del', text: oldLines[i]! })
      i++
    } else {
      script.push({ kind: 'add', text: newLines[j]! })
      j++
    }
  }
  while (i < n) script.push({ kind: 'del', text: oldLines[i++]! })
  while (j < m) script.push({ kind: 'add', text: newLines[j++]! })
  return script
}

/**
 * One side of a `@@` header, in git's own shorthand: 1-based start line, the
 * `,count` omitted when the hunk covers a single line, and an explicit `,0`
 * (starting at the line *before* the change) when that side is empty — the
 * "pure addition" case.
 */
function hunkRange(countBefore: number, count: number): string {
  if (count === 0) return `${countBefore},0`
  const from = countBefore + 1
  return count === 1 ? `${from}` : `${from},${count}`
}

/**
 * The unified diff of `oldText` → `newText` for `path`: `---`/`+++` headers
 * then one or more `@@` hunks, each with up to `CONTEXT` unchanged lines
 * around the change. `oldText` omitted (or `undefined`) means the file is
 * created, so the old side reads `/dev/null`.
 *
 * `undefined` when there is nothing to show: identical old and new text, or
 * both sides empty — an entry with no diff is not a no-op line in the mirror.
 */
export function unifiedDiff(
  path: string | undefined,
  oldText: string | undefined,
  newText: string,
): string | undefined {
  const oldIsAbsent = oldText === undefined
  const before = oldIsAbsent ? [] : splitLines(oldText)
  const after = splitLines(newText)
  if (!oldIsAbsent && oldText === newText) return undefined
  if (before.length === 0 && after.length === 0) return undefined

  const name = path ?? 'file'
  const header = [
    `--- ${oldIsAbsent ? DEV_NULL : `a/${name}`}`,
    `+++ b/${name}`,
  ]

  const script = editScript(before, after)
  // Line numbers of each script line in its own side, so a hunk header can be
  // built without re-walking the script.
  const oldNo: number[] = []
  const newNo: number[] = []
  let o = 0
  let nw = 0
  for (const line of script) {
    // Counted *before* the line, so a hunk starting here reports the lines
    // preceding it (and `,0` for a side this line does not touch).
    oldNo.push(o)
    newNo.push(nw)
    if (line.kind !== 'add') o++
    if (line.kind !== 'del') nw++
  }

  const changed = script.some((l) => l.kind !== 'ctx')
  if (!changed) return undefined

  // Cluster the changes: a gap of more than 2·CONTEXT unchanged lines starts a
  // new hunk (git's rule — anything closer would be almost all context).
  const clusters: [number, number][] = []
  for (let i = 0; i < script.length; i++) {
    if (script[i]!.kind === 'ctx') continue
    const last = clusters.at(-1)
    if (last && i - last[1] <= 2 * CONTEXT + 1) last[1] = i
    else clusters.push([i, i])
  }

  const hunks: string[][] = []
  for (const [first, last] of clusters) {
    const start = Math.max(0, first - CONTEXT)
    const end = Math.min(script.length, last + CONTEXT + 1)
    const body = script.slice(start, end)
    const oldCount = body.filter((l) => l.kind !== 'add').length
    const newCount = body.filter((l) => l.kind !== 'del').length
    const oldStart = oldNo[start] ?? 0
    const newStart = newNo[start] ?? 0
    const hunk = [`@@ -${hunkRange(oldStart, oldCount)} +${hunkRange(newStart, newCount)} @@`]
    for (const line of body) {
      const marker = line.kind === 'del' ? '-' : line.kind === 'add' ? '+' : ' '
      hunk.push(marker + line.text)
    }
    hunks.push(hunk)
  }

  return capDiff(header, hunks)
}

/**
 * Clamp a rendered diff to `DIFF_MAX`, closing with a marker that says how many
 * lines were dropped — a silently shortened diff reads as a complete one, which
 * would be a lie about the change.
 *
 * Whole hunks are kept or dropped whole. The one hunk that straddles the budget
 * is cut at a line boundary, and *its `@@` header is dropped with the lines it
 * no longer describes*: a `@@ -1,277 +1,277 @@` header above 37 of its 277 body
 * lines claims a range it does not cover, and every reader — including the
 * diff-aware highlighter in Element — takes the header as the hunk's extent.
 *
 * Dropping the header is not enough on its own: the surviving body would then
 * sit directly under the *previous* hunk's `@@` header, which would over-claim
 * just as badly. A headerless excerpt is therefore preceded by an explicit
 * separator line, so no `@@` header ever sits above lines it does not describe.
 */
function capDiff(header: string[], hunks: string[][]): string {
  const out: string[] = [...header]
  let used = header.reduce((n, line) => n + line.length + 1, 0)
  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i]!
    const size = hunk.reduce((n, line) => n + line.length + 1, 0)
    if (used + size <= DIFF_MAX) {
      used += size
      out.push(...hunk)
      continue
    }
    // The hunk straddles the budget: mark the excerpt, keep the body lines that
    // fit, and count the cut header plus every later line as dropped.
    const marker = '… excerpt of the next hunk'
    // Only needed when whole hunks were kept above: with nothing above it, the
    // excerpt already follows the `---`/`+++` headers, which claim no range.
    const needsMarker = out.length > header.length
    if (needsMarker && used + marker.length + 1 > DIFF_MAX) {
      out.push(`… +${hunk.length + hunks.slice(i + 1).reduce((n, h) => n + h.length, 0)} more diff lines`)
      return out.join('\n')
    }
    if (needsMarker) {
      used += marker.length + 1
      out.push(marker)
    }
    let dropped = hunk.length
    for (let j = 1; j < hunk.length; j++) {
      const line = hunk[j]!
      if (used + line.length + 1 > DIFF_MAX) break
      used += line.length + 1
      dropped--
      out.push(line)
    }
    dropped += hunks.slice(i + 1).reduce((n, h) => n + h.length, 0)
    out.push(`… +${dropped} more diff lines`)
    return out.join('\n')
  }
  return out.join('\n')
}

/** One ACP `content[]` entry that describes a change, if any is present. */
interface DiffBlock {
  path?: string
  oldText?: string
  newText?: string
}

/**
 * The first `content[]` entry of type `diff` in a `tool_call_update` payload.
 * When the agent sends one, it is authoritative — it is the agent's own view of
 * the change, already framed for display — and the raw input is only a
 * fallback. `undefined` when the update carries no diff block.
 */
function diffContentBlock(content: unknown): DiffBlock | undefined {
  if (!Array.isArray(content)) return undefined
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    if (rec.type !== 'diff') continue
    const text = (v: unknown): string | undefined =>
      typeof v === 'string' ? v : undefined
    return {
      path: text(rec.path),
      oldText: text(rec.oldText),
      newText: text(rec.newText),
    }
  }
  return undefined
}

/**
 * The unified diff for a tool call, or `undefined` when it shows no change.
 *
 * Two sources, in order of authority:
 *  1. a `diff` block in the `tool_call_update` `content[]` — the agent's own
 *     rendering of the change, used when present;
 *  2. the ACP `rawInput`'s old/new text (`oldString`/`newString` and the other
 *     spellings in `OLD_NEW_KEY_PAIRS`), the `path` keys naming the file.
 *
 * A call that carries only new content (a `write`/`create` of a whole file)
 * diffs as pure additions. Anything else — no old and no new text, a `bash`
 * command, a `read` — is not a file change, so it gets no diff and keeps its
 * existing params/output rendering.
 */
export function toolCallDiff(
  content: Record<string, unknown>,
): string | undefined {
  const block = diffContentBlock(content.content)
  if (block?.newText !== undefined) {
    const path = block.path ?? firstString(content.raw_input, PATH_KEYS)
    return unifiedDiff(path, block.oldText, block.newText)
  }
  const input = content.raw_input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const rec = input as Record<string, unknown>
  for (const [oldKey, newKey] of OLD_NEW_KEY_PAIRS) {
    const newText = rec[newKey]
    if (typeof newText !== 'string') continue
    const oldText = rec[oldKey]
    if (oldText !== undefined && typeof oldText !== 'string') continue
    return unifiedDiff(firstString(rec, PATH_KEYS), oldText, newText)
  }
  const path = firstString(rec, PATH_KEYS)
  const head = titleHead(content.title) ?? titleHead(content.kind)
  if (!path || !head || !CREATE_TITLES.has(head)) return undefined
  for (const key of NEW_CONTENT_KEYS) {
    const newText = rec[key]
    if (typeof newText === 'string' && newText.length > 0) {
      return unifiedDiff(path, undefined, newText)
    }
  }
  return undefined
}

/**
 * The `rawInput` keys whose values are the change itself, so a call that renders
 * a diff drops them from its params line: the diff *is* those strings, and
 * printing them again as `oldString=…` re-says the change as one clamped
 * fragment. Only these keys go — a `write`'s `filePath` or an `edit`'s
 * `replace_all` / `expected_replacements` is not in the diff and stays visible.
 */
export const DIFF_PARAM_KEYS: ReadonlySet<string> = new Set([
  ...OLD_NEW_KEY_PAIRS.flat(),
  ...NEW_CONTENT_KEYS,
])

/** Path-ish keys an ACP `rawInput` uses to name the file a tool touches. */
const PATH_KEYS = ['filePath', 'filepath', 'file_path', 'path']

/** First non-empty string among `keys` of a raw object; `undefined` when absent. */
function firstString(
  obj: unknown,
  keys: readonly string[],
): string | undefined {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined
  const rec = obj as Record<string, unknown>
  for (const key of keys) {
    const value = rec[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}
