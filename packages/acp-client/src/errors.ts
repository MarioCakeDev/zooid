import { RequestError } from '@agentclientprotocol/sdk'

export type ErrorCode =
  | 'auth_missing'
  | 'auth_invalid'
  | 'model_rate_limit'
  | 'model_unavailable'
  | 'image_pull_failed'
  | 'mount_failed'
  | 'container_exit'
  | 'acp_protocol'
  | 'permission_denied'
  | 'media_failed'
  | 'session_wedge'
  | 'internal'

/**
 * A prompt was delivered into the agent's ACP stream but the agent produced
 * nothing at all — no `agent_message_chunk`, no tool call, no completion —
 * within the first-response deadline. The classic case is a session resumed
 * across a daemon restart whose backing process is gone: the shim accepts the
 * notification and then stays silent forever.
 *
 * Distinct from a slow agent: a slow agent *does* answer, it just answers
 * late, and the deadline is sized for that. A wedge never answers at all.
 *
 * The thrower has already invalidated the wedged session and marked the client
 * dead, so callers treat this as "discard everything you had and start over".
 */
export class AcpSessionWedgeError extends Error {
  readonly wedge = true
  /** ACP session id that never answered, when one was established. */
  readonly sessionId: string | null
  /** Deadline that elapsed, in ms. 0 means the check was disabled. */
  readonly timeoutMs: number

  constructor(message: string, opts: { sessionId?: string | null; timeoutMs: number }) {
    super(message)
    this.name = 'AcpSessionWedgeError'
    this.sessionId = opts.sessionId ?? null
    this.timeoutMs = opts.timeoutMs
  }
}

/** Type guard for {@link AcpSessionWedgeError} (survives realm boundaries). */
export function isSessionWedge(err: unknown): err is AcpSessionWedgeError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { wedge?: unknown }).wedge === true &&
    (err as { name?: unknown }).name === 'AcpSessionWedgeError'
  )
}

export interface Classified {
  code: ErrorCode
  transient: boolean
  /** Verbatim ACP RequestError triple — forwarded into dev.zooid.error.acp_error. */
  acp_error?: { code: number; message: string; data?: unknown }
}

const PROTOCOL_CODES = new Set([-32700, -32600, -32601, -32602])

export function classify(err: unknown): Classified {
  if (err instanceof RequestError) {
    const acp_error = { code: err.code, message: err.message, data: err.data }
    if (PROTOCOL_CODES.has(err.code)) return { code: 'acp_protocol', transient: false, acp_error }
    if (err.code === -32603) return { code: 'internal', transient: false, acp_error }
    // -32002 (spec authRequired) → auth_missing
    if (err.code === -32002) return { code: 'auth_missing', transient: false, acp_error }
    // -32000…-32099 generic: classify by message
    const m = err.message
    if (/^auth(entication)? required$/i.test(m)) {
      return { code: 'auth_missing', transient: false, acp_error }
    }
    if (/\b(token|api ?key|credential)\b/i.test(m) && /\b(invalid|expired|revoked)\b/i.test(m)) {
      return { code: 'auth_invalid', transient: false, acp_error }
    }
    if (/\brate ?limit\b|\b429\b/i.test(m)) {
      return { code: 'model_rate_limit', transient: true, acp_error }
    }
    if (/\b5\d\d\b|\boverloaded\b|\bunavailable\b|\bunknown model\b/i.test(m)) {
      return { code: 'model_unavailable', transient: true, acp_error }
    }
    return { code: 'internal', transient: false, acp_error }
  }

  if (isSessionWedge(err)) return { code: 'session_wedge', transient: true }

  // Out-of-band errors (no RequestError → no acp_error).
  if (err instanceof Error) {
    const m = err.message
    if (/error while creating mount source path|mkdir .* permission denied/i.test(m)) {
      return { code: 'mount_failed', transient: false }
    }
    if (/^image prepull failed/i.test(m)) {
      return { code: 'image_pull_failed', transient: true }
    }
    if (/ACP connection closed/i.test(m)) {
      return { code: 'container_exit', transient: true }
    }
  }

  return { code: 'internal', transient: false }
}
