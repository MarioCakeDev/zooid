import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type {
  ApprovalDecision,
  ApprovalRequest,
} from '@zooid/acp-client'

export interface RegisteredApproval {
  approvalId: string
  agentName: string
  sessionId: string
  toolCallId: string
  toolKind?: string
  toolTitle?: string
  toolInput?: unknown
  options: ApprovalRequest['options']
  decisionPromise: Promise<ApprovalDecision>
}

export interface RegisterOptions {
  /** Wall-clock timeout in ms. 0 = no timeout. */
  timeoutMs?: number
}

interface PendingEntry extends RegisteredApproval {
  resolve(decision: ApprovalDecision): void
  timer?: ReturnType<typeof setTimeout>
}

/**
 * Correlates ACP approval requests (mid-prompt, originating in `AcpClient`)
 * with HTTP/transport-side decisions. The transport listens to:
 *
 *   - `'registered'` — fires after `register()` so the transport can emit
 *     `approval.request` on the right SSE stream.
 *   - `'timeout'`    — fires when an entry is auto-cancelled by the timer
 *     so the transport can emit `approval.timeout`.
 *   - `'resolved'`   — fires whenever a pending entry leaves the map with a
 *     decision (via `resolve`, `resolveById`, `cancelSession`, or the timeout)
 *     so transports can drop any correlation state they kept for it.
 */
export class ApprovalCorrelator extends EventEmitter {
  private readonly pending = new Map<string, PendingEntry>()
  private readonly bySession = new Map<string, Set<string>>()

  register(
    agentName: string,
    sessionId: string,
    req: ApprovalRequest,
    opts: RegisterOptions = {},
  ): RegisteredApproval {
    const approvalId = randomUUID()
    let resolve!: (d: ApprovalDecision) => void
    const decisionPromise = new Promise<ApprovalDecision>((r) => {
      resolve = r
    })
    const entry: PendingEntry = {
      approvalId,
      agentName,
      sessionId,
      toolCallId: req.toolCallId,
      toolKind: req.toolKind,
      toolTitle: req.toolTitle,
      toolInput: req.toolInput,
      options: req.options,
      decisionPromise,
      resolve,
    }
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        if (this.pending.get(approvalId) !== entry) return
        this.settle(entry, { decision: 'cancel' })
        this.emit('timeout', { approvalId, sessionId, agentName })
      }, opts.timeoutMs)
      entry.timer.unref?.()
    }
    this.pending.set(approvalId, entry)
    let set = this.bySession.get(sessionId)
    if (!set) {
      set = new Set()
      this.bySession.set(sessionId, set)
    }
    set.add(approvalId)
    this.emit('registered', this.toPublic(entry))
    return this.toPublic(entry)
  }

  resolve(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): boolean {
    const entry = this.pending.get(approvalId)
    if (!entry || entry.sessionId !== sessionId) return false
    this.settle(entry, decision)
    return true
  }

  /**
   * Resolve without the caller having to know the session id — used by the
   * Matrix transport's reaction / `approve <id>` paths, which correlate the
   * approval id to its message first. Returns false when the approval is
   * unknown or already resolved, so a double approve is a no-op.
   */
  resolveById(approvalId: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(approvalId)
    if (!entry) return false
    this.settle(entry, decision)
    return true
  }

  /** The pending approval with this id, or undefined. */
  get(approvalId: string): RegisteredApproval | undefined {
    const entry = this.pending.get(approvalId)
    return entry ? this.toPublic(entry) : undefined
  }

  private settle(entry: PendingEntry, decision: ApprovalDecision): void {
    if (entry.timer) clearTimeout(entry.timer)
    entry.resolve(decision)
    this.pending.delete(entry.approvalId)
    this.bySession.get(entry.sessionId)?.delete(entry.approvalId)
    this.emit('resolved', {
      approvalId: entry.approvalId,
      sessionId: entry.sessionId,
      agentName: entry.agentName,
      decision,
    })
  }

  cancelSession(sessionId: string): void {
    const ids = this.bySession.get(sessionId)
    if (!ids) return
    for (const id of [...ids]) {
      const entry = this.pending.get(id)
      if (entry) this.settle(entry, { decision: 'cancel' })
    }
    this.bySession.delete(sessionId)
  }

  listPending(sessionId: string): RegisteredApproval[] {
    const ids = this.bySession.get(sessionId)
    if (!ids) return []
    const out: RegisteredApproval[] = []
    for (const id of ids) {
      const entry = this.pending.get(id)
      if (entry) out.push(this.toPublic(entry))
    }
    return out
  }

  size(): number {
    return this.pending.size
  }

  private toPublic(entry: PendingEntry): RegisteredApproval {
    return {
      approvalId: entry.approvalId,
      agentName: entry.agentName,
      sessionId: entry.sessionId,
      toolCallId: entry.toolCallId,
      toolKind: entry.toolKind,
      toolTitle: entry.toolTitle,
      toolInput: entry.toolInput,
      options: entry.options,
      decisionPromise: entry.decisionPromise,
    }
  }
}
