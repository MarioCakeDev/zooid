/**
 * A trigger-authored message expires; a human's never does. The marker lives on
 * the event (`dev.zooid.trigger`) rather than on the room or the sync cursor,
 * because only the trigger knows whether a replay is still useful — see
 * [[ZOD081]] §Design 6.
 *
 * Anything malformed is treated as non-expiring: dropping a message we failed to
 * parse is a worse failure than handling a stale one.
 */
export function isExpiredTrigger(evt: { content?: Record<string, unknown> }, now: number): boolean {
  const stamp = evt.content?.['dev.zooid.trigger']
  if (!stamp || typeof stamp !== 'object') return false
  const { fired_at: firedAt, ttl_ms: ttlMs } = stamp as { fired_at?: unknown; ttl_ms?: unknown }
  if (typeof firedAt !== 'number' || typeof ttlMs !== 'number') return false
  return now - firedAt > ttlMs
}
