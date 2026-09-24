---
'@zooid/transport-matrix': patch
---

Fix the threaded-turn mirror regression: never root a thread on a related event

When a turn was triggered by an event that itself carried an `m.relates_to` —
an edit (`m.replace`) of a threaded message, or a rich reply (`m.in_reply_to`) —
the daemon promoted that event to a thread root of its own. Synapse refuses to
start a thread from an event that already has a relation
(`M_UNKNOWN: Cannot start threads from an event with a relation`), so every
outbound event for the turn — the per-turn `dev.zooid.mirror` line and the
custom `dev.zooid.*` activity events alike — 400'd.

- `inboundThreadRoot` now reads the thread relation from `m.new_content` for
  edits, so an edited threaded message stays in its thread.
- A new `threadRootFor` only lets a relation-free event become a thread root;
  a rich reply anchors the new thread at the event it replies to instead.

Top-level turns are unchanged: they still start a thread rooted on the trigger.
