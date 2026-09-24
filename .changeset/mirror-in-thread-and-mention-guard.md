---
'@zooid/transport-matrix': patch
'zooid': patch
---

Fix the in-thread per-turn mirror and stop mirrored mentions re-waking agents

Two regressions in the v2 Element mirror, both visible on the live daemon.

- **In-thread mirror (`Cannot start threads from an event with a relation`).**
  An inbound event that already carries a relation was used verbatim as the
  turn's thread root (`resolveThreadRoot(evt) ?? evt.event_id`), so every
  outbound event — the raw `dev.zooid.*` custom events and the per-turn mirror
  line — related its `m.thread` to a related event, which Synapse refuses. This
  broke every threaded conversation. Thread-root resolution now understands
  edits (`m.new_content.m.relates_to`, MSC2676 + MSC3440) and a related event
  that does not resolve to a thread is never promoted to a root. As a safety
  net, if a session's root still refuses the relation (a thread already rooted
  at a related event), the mirror falls back to a top-level line instead of
  failing every turn, and later edits stay top-level.
- **Mention-trigger echo guard.** The `mention` trigger re-dispatched an agent
  whenever a mention string appeared in another agent's message, including
  mirrored or echoed content (the per-turn line echoes tool activity, and a
  `zooid_get_history` result quotes old messages and their mentions), causing
  feedback loops. The router now ignores the transport's own mirror messages
  (`dev.zooid.mirror`, on the line and on each edit), and the transport adds a
  `TriggerGuard` that dedupes the same `(event, target)` within a window and
  applies a hard per-target cap. The guard is journaled (`triggers.json`, wired
  through the daemon's data directory) so a restart cannot replay an
  already-dispatched event into a fresh turn.
