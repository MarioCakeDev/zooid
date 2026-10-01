---
'@zooid/transport-matrix': patch
---

Element mirror: coalesce in-place edits to one per 5s (fixes `M_LIMIT_EXCEEDED`)

A busy turn emits a burst of `tool_call`/`tool_call_update`/`plan` events, and
each one rewrote the turn's mirror line in place with an `m.replace`. Dozens of
edits per turn tripped the homeserver's rate limit and produced
`M_LIMIT_EXCEEDED` (429) in the daemon log.

The mirror now throttles its in-place edits to **at most one per 5 seconds per
turn**:

- the first edit of a window is sent immediately, so the line stays responsive;
- every frame arriving inside the window is coalesced, and one trailing edit
  carrying the latest frame lands when the window elapses;
- **turn end always flushes immediately** — any pending edit is sent before the
  terminal `✅/⚠️` summary, so the mirror is never left on a stale throttled
  frame and the terminal status is never lost.

The single-entry invariant (one notice per group, edited in place, never
duplicated) and the thread relation are unchanged. Configurable via
`mirrorEditIntervalMs` (`0` disables the throttle; defaults to 5000).
