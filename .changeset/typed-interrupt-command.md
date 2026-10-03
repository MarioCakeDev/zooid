---
'@zooid/transport-matrix': patch
---

Typed `/interrupt` cancels a running agent task from any Matrix client

A stock client (Element etc.) cannot send the `dev.zooid.interrupt` custom
event, so the only way to stop a running turn was to close the app and use the
Zooid client. A plain-text `/interrupt` was routed as ordinary prose instead.

- The thread-relation interrupt body is factored into a shared
  `interruptThread({ threadRoot, reason, roomId })` helper that cancels every
  session bound to the root and closes its open task, reused by the custom
  event and the new command path.
- `handleInboundEvent` now recognises an `m.room.message` from a non-agent
  whose trimmed body is `/interrupt` or `/interrupt@<agent>` (case-insensitive).
  It resolves the root as the thread relation, or the event's own id when
  top-level, runs `interruptThread`, and returns without enqueuing a turn.
- `/interrupt` authored by one of our own agents is swallowed so an agent turn
  that emits the string cannot cancel a peer or itself and loop. Every other
  slash string stays normal prose.
- A short in-thread `m.notice` (`⏹ interrupted by <user>`) confirms the
  cancellation; it carries the mirror marker so the router never treats it as
  content and re-triggers an agent.
