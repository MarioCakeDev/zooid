---
'@zooid/transport-matrix': patch
---

An in-thread handoff from a closed task's thread returns to its caller

A thread whose delegated task had closed stayed classified as a task thread in
`handleInboundEvent`, even though #100 made it route like an ordinary one. That
had two effects on an ordinary `zooid_handoff` made in it: the call edge never
called `returns.open`, and `route()` suppressed `isReturnRoute`, so the callee's
reply was never held. The callee woke, did the work, and ended its turn, but the
caller was never woken with `[handoff return] from <callee>` — and the handoff
stayed open, refusing a second one as `already_open`.

The task context now requires an *open* task. A closed task's root is still kept
for trust checks, but its thread routes and returns through the ordinary
`PendingReturns` path. The open-task invocation/return path is unchanged.
