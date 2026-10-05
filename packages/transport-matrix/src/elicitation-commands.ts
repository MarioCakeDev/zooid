import type { ElicitationSchema } from '@zooid/acp-client'
import { normaliseReactionKey } from './approval-commands.js'

/**
 * Turning a stock-Matrix-client interaction into an elicitation answer.
 *
 * The Zooid client answers a form with a `dev.zooid.elicitation_response`
 * custom event. A stock Element client cannot send custom events, so the daemon
 * also accepts a plain `m.room.message` reply in the question's thread:
 *
 *   - `answer <request_id> <value>` — a bare value for a single-field form
 *     (string/enum, or a JSON-coerced number/boolean), a comma list for a
 *     single multi-select field, or a JSON object for any form;
 *   - `decline <request_id>` / `cancel <request_id>`;
 *   - a number-keycap reaction (1️⃣…9️⃣) on the question's notice when the schema
 *     is a single enum field with at most nine choices.
 *
 * Everything here is pure so the mapping is unit-testable away from transport.
 */

export type ElicitationAction = 'answer' | 'decline' | 'cancel'

export interface ParsedElicitationCommand {
  action: ElicitationAction
  requestId: string
  /** Raw value for `answer`: everything after the id, trimmed. */
  value?: string
}

// `answer <id> <value…>` requires a value; `decline`/`cancel` take only the id.
// Anchored so ordinary prose ("answer the question") never matches.
const ANSWER_RE = /^\s*answer\s+(\S+)\s+([\s\S]+?)\s*$/i
const DECISION_RE = /^\s*(decline|cancel)\s+(\S+)\s*$/i

export function parseElicitationCommand(body: string): ParsedElicitationCommand | null {
  const a = ANSWER_RE.exec(body)
  if (a) return { action: 'answer', requestId: a[1], value: a[2] }
  const d = DECISION_RE.exec(body)
  if (d) return { action: d[1].toLowerCase() as 'decline' | 'cancel', requestId: d[2] }
  return null
}

// Requests are `randomUUID()` values (same shape as approval ids).
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isElicitationRequestId(token: string | undefined): boolean {
  return token !== undefined && REQUEST_ID_RE.test(token)
}

type Prop = Record<string, unknown> & { type?: unknown }

function propChoices(p: Prop): string[] | undefined {
  if (Array.isArray(p.enum)) return p.enum.filter((x): x is string => typeof x === 'string')
  if (Array.isArray(p.oneOf)) {
    return p.oneOf.flatMap((o) =>
      typeof o === 'object' && o !== null && typeof (o as { const?: unknown }).const === 'string'
        ? [(o as { const: string }).const]
        : [],
    )
  }
  return undefined
}

export interface ElicitationField {
  name: string
  type: string
  required: boolean
  choices?: string[]
}

export function elicitationFields(schema: ElicitationSchema): ElicitationField[] {
  const props = (schema.properties ?? {}) as Record<string, Prop>
  const required = new Set(schema.required ?? [])
  return Object.entries(props).map(([name, raw]) => {
    const p = (typeof raw === 'object' && raw !== null ? raw : {}) as Prop
    const choices = propChoices(p)
    return {
      name,
      type: typeof p.type === 'string' ? p.type : 'unknown',
      required: required.has(name),
      ...(choices ? { choices } : {}),
    }
  })
}

/**
 * The single string-enum field of a form, when it is the *only* field and has
 * at most nine choices — the shape a number-keycap reaction can answer
 * unambiguously.
 */
export function singleEnumField(
  schema: ElicitationSchema,
): { name: string; choices: string[] } | undefined {
  const fields = elicitationFields(schema)
  if (fields.length !== 1) return undefined
  const [f] = fields
  if (f.type !== 'string' || !f.choices || f.choices.length < 1 || f.choices.length > 9) return undefined
  return { name: f.name, choices: f.choices }
}

export type ElicitationAnswerResult =
  | { ok: true; content: Record<string, unknown> }
  | { ok: false; error: string }

/** Parse a bare command value into the schema field's type without coercing outside it. */
function coerceScalar(raw: string, type: string): unknown {
  if (type === 'number' || type === 'integer' || type === 'boolean') {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  return raw
}

export function contentFromAnswer(schema: ElicitationSchema, raw: string): ElicitationAnswerResult {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return { ok: false, error: 'could not parse the JSON answer' }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: 'the JSON answer must be an object' }
    }
    return { ok: true, content: parsed as Record<string, unknown> }
  }
  const fields = elicitationFields(schema)
  if (fields.length === 0) return { ok: false, error: 'this question takes no fields' }
  if (fields.length > 1) {
    return {
      ok: false,
      error: 'this form has multiple fields — answer with JSON, e.g. {"field":"value"}',
    }
  }
  const [f] = fields
  if (f.type === 'array') {
    const values = trimmed
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
    return { ok: true, content: { [f.name]: values } }
  }
  return { ok: true, content: { [f.name]: coerceScalar(trimmed, f.type) } }
}

// Canonical keycap digit emojis (digit + U+20E3). A client may insert VS16
// between the digit and the keycap; `normaliseReactionKey` strips it first.
const KEYCAP_REACTIONS: Record<string, number> = {
  '1\u20E3': 0,
  '2\u20E3': 1,
  '3\u20E3': 2,
  '4\u20E3': 3,
  '5\u20E3': 4,
  '6\u20E3': 5,
  '7\u20E3': 6,
  '8\u20E3': 7,
  '9\u20E3': 8,
}

/** 0-based index of a number-keycap reaction, or undefined for any other key. */
export function reactionIndex(key: unknown): number | undefined {
  return KEYCAP_REACTIONS[normaliseReactionKey(key)]
}
