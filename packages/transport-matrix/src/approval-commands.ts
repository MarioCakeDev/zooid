import type { ApprovalDecision, ApprovalRequest } from '@zooid/acp-client'

/**
 * Turning a stock-Matrix-client interaction into an approval decision.
 *
 * The Zooid client answers approvals with a `dev.zooid.approval_response`
 * custom event. A stock Element client cannot send custom events, so the
 * daemon also accepts two standard interactions:
 *
 *   - a plain `m.room.message` whose body is `approve <id>` / `deny <id>`
 *     (or a bare `approve` / `deny` when exactly one approval is pending in
 *     the thread);
 *   - a ✅ / ❌ reaction on the approval message (the custom event or its
 *     mirrored `m.notice`).
 *
 * Everything here is pure so the decision mapping is unit-testable in
 * isolation from the transport.
 */

export type ApprovalOption = ApprovalRequest['options'][number]

export type ApprovalCommand = 'approve' | 'deny'

/** Canonical reaction keys. Kept deliberately narrow — no aliases. */
export const APPROVE_REACTION = '✅'
export const DENY_REACTION = '❌'

export function reactionCommand(key: unknown): ApprovalCommand | undefined {
  if (key === APPROVE_REACTION) return 'approve'
  if (key === DENY_REACTION) return 'deny'
  return undefined
}

export interface ParsedApprovalCommand {
  command: ApprovalCommand
  /** Explicit approval id, or undefined for the bare form. */
  approvalId?: string
}

// `approve <id>` / `deny <id>` / bare `approve` / `deny`. Anchored so ordinary
// prose ("please approve the plan") never matches.
const COMMAND_RE = /^\s*(approve|deny)\b(?:\s+(\S+))?\s*$/i

export function parseApprovalCommand(body: string): ParsedApprovalCommand | null {
  const m = COMMAND_RE.exec(body)
  if (!m) return null
  return { command: m[1].toLowerCase() as ApprovalCommand, approvalId: m[2] }
}

// Approval ids are `randomUUID()` values. Requiring this shape means a prose
// message that merely starts with the word ("approve please") is not treated as
// an id-bearing command and routes normally.
const APPROVAL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isApprovalId(token: string | undefined): boolean {
  return token !== undefined && APPROVAL_ID_RE.test(token)
}

export type DecisionResolution =
  | { ok: true; decision: ApprovalDecision }
  | { ok: false; reason: string }

/**
 * Map a command to an ACP decision. ACP carries the allow/reject choice in the
 * selected `optionId` (`decision: 'allow'` means "an option was selected");
 * `{ decision: 'cancel' }` is the only way to decline when the request exposes
 * no reject option.
 */
export function decisionForCommand(
  command: ApprovalCommand,
  options: ApprovalOption[],
): DecisionResolution {
  const list = Array.isArray(options) ? options : []
  // Option order is agent-controlled, so never pick the first `allow*` blindly:
  // prefer the narrowest ("once") over the persistent ("always") option.
  const pick = (prefix: string, preferred: string): ApprovalOption | undefined => {
    const matches = list.filter((o) => typeof o.kind === 'string' && o.kind.startsWith(prefix))
    if (matches.length === 0) return undefined
    return matches.find((o) => o.kind === preferred) ?? matches[0]
  }

  if (command === 'approve') {
    const allow = pick('allow', 'allow_once')
    if (allow) {
      return { ok: true, decision: { decision: 'allow', optionId: allow.optionId } }
    }
    // A request with a single option (e.g. a yes/no confirm) still has an
    // unambiguous answer.
    if (list.length === 1) {
      return { ok: true, decision: { decision: 'allow', optionId: list[0].optionId } }
    }
    return { ok: false, reason: 'this request offers no "allow" option' }
  }

  const reject = pick('reject', 'reject_once')
  if (reject) {
    return { ok: true, decision: { decision: 'allow', optionId: reject.optionId } }
  }
  return { ok: true, decision: { decision: 'cancel' } }
}
