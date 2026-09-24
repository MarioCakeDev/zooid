/**
 * Dedupe + rate-limit for the `mention` trigger.
 *
 * The trigger is content-driven: any `@agent` string in a message body wakes
 * that agent. Mirrored or echoed content — the per-turn display line, a
 * `zooid_get_history` result quoting an old message — can therefore carry a
 * stale mention and re-dispatch an agent in a feedback loop. This guard makes a
 * dispatch idempotent per `(event, target)` and caps how often one target can be
 * woken by a mention inside a rolling window.
 *
 * The state is journaled so a daemon restart cannot replay the same event into a
 * fresh dispatch: the entries carry absolute timestamps and are pruned against
 * the wall clock on load.
 */

export interface PersistedTriggerEntry {
  /** `${event_id}::${target}` — the dedupe key. */
  key: string
  /** Agent name the dispatch was for. */
  target: string
  /** `Date.now()` when the dispatch was allowed. */
  at: number
}

export interface PersistedTriggerGuard {
  version: 1
  entries: PersistedTriggerEntry[]
}

export interface TriggerJournal {
  load(): PersistedTriggerGuard | undefined
  save(state: PersistedTriggerGuard): void
}

export interface TriggerGuardOptions {
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number
  /** Same `(event, target)` is suppressed within this window. */
  dedupeMs?: number
  /** Rolling window for the per-target hard cap. */
  rateWindowMs?: number
  /** Maximum mention dispatches to one target per window. */
  maxPerWindow?: number
  /** Upper bound on retained entries. */
  maxEntries?: number
  journal?: TriggerJournal
}

export type TriggerDecision =
  | { allowed: true }
  | { allowed: false; reason: 'duplicate' | 'rate_limited' }

export const DEFAULT_TRIGGER_DEDUPE_MS = 5 * 60_000
export const DEFAULT_TRIGGER_RATE_WINDOW_MS = 60_000
export const DEFAULT_TRIGGER_MAX_PER_WINDOW = 30
const DEFAULT_MAX_ENTRIES = 2_000

export class TriggerGuard {
  private readonly now: () => number
  private readonly dedupeMs: number
  private readonly rateWindowMs: number
  private readonly maxPerWindow: number
  private readonly maxEntries: number
  private readonly journal?: TriggerJournal
  private entries: PersistedTriggerEntry[]

  constructor(opts: TriggerGuardOptions = {}) {
    this.now = opts.now ?? Date.now
    this.dedupeMs = opts.dedupeMs ?? DEFAULT_TRIGGER_DEDUPE_MS
    this.rateWindowMs = opts.rateWindowMs ?? DEFAULT_TRIGGER_RATE_WINDOW_MS
    this.maxPerWindow = opts.maxPerWindow ?? DEFAULT_TRIGGER_MAX_PER_WINDOW
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.journal = opts.journal
    const loaded = this.journal?.load()
    this.entries =
      loaded?.version === 1 && Array.isArray(loaded.entries) ? loaded.entries : []
    this.prune(this.now())
  }

  private keyFor(eventId: string | undefined, target: string): string {
    return `${eventId ?? ''}::${target}`
  }

  private prune(now: number): void {
    const horizon = now - Math.max(this.dedupeMs, this.rateWindowMs)
    this.entries = this.entries.filter((e) => e.at > horizon)
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(this.entries.length - this.maxEntries)
    }
  }

  /**
   * Decide whether `target` may be woken by `eventId`. Returns `allowed: false`
   * for a duplicate within the dedupe window or once the per-target rate cap is
   * reached. An allowed decision is recorded (and journaled) immediately, so a
   * second call for the same `(event, target)` is suppressed even if the first
   * dispatch later fails.
   */
  allow(eventId: string | undefined, target: string): TriggerDecision {
    const now = this.now()
    this.prune(now)
    const key = this.keyFor(eventId, target)
    if (
      eventId !== undefined &&
      this.entries.some((e) => e.key === key && e.at > now - this.dedupeMs)
    ) {
      return { allowed: false, reason: 'duplicate' }
    }
    const recent = this.entries.filter(
      (e) => e.target === target && e.at > now - this.rateWindowMs,
    ).length
    if (recent >= this.maxPerWindow) return { allowed: false, reason: 'rate_limited' }
    this.entries.push({ key, target, at: now })
    this.prune(now)
    this.journal?.save({ version: 1, entries: this.entries })
    return { allowed: true }
  }
}
