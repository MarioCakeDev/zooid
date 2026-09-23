---
'@zooid/core': patch
'@zooid/transport-matrix': patch
---

Mirror `dev.zooid.*` activity as Matrix notices and accept approvals from any client

Stock Element (X / Desktop / Web) cannot render Zooid's custom events, so agent
activity was invisible there and approvals could only be answered by a client
that sends `dev.zooid.approval_response`.

- **Mirror.** Every outbound `dev.zooid.*` activity event now also goes out as a
  threaded `m.room.message` (`m.notice`) with a compact one-line summary —
  `tool_call`, `tool_call_update`, `plan`, `available_commands_update`,
  `approval_request`, and `error` (whose existing `body` is reused). The custom
  events are unchanged. Two events are deliberately not mirrored:
  `dev.zooid.turn.end` is a per-turn boundary marker whose `body` is a
  push-notification preview rather than timeline content, and the
  `dev.zooid.workforce` state event lives in an `m.space` container that
  Element surfaces through the space rather than a message timeline.
- **Interactive approvals.** The daemon now also resolves an approval from a
  plain `m.room.message` (`approve <id>` / `deny <id>`, or a bare
  `approve` / `deny` when exactly one approval is pending in the thread) and
  from a ✅ / ❌ reaction on the approval's custom event or its mirrored notice.
  Commands/reactions from Zooid's own bot users are ignored so an agent cannot
  self-approve. Correlation is idempotent: `ApprovalCorrelator.resolveById`
  deletes the pending entry, so a double approve is a no-op.
- `ApprovalCorrelator` gains `resolveById()` and `get()`, and emits `resolved`
  so transports can drop the correlation state they kept for an approval.
