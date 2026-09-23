---
'@zooid/transport-matrix': patch
---

Element mirror v2: one editable line per agent turn

v1 mirrored every `dev.zooid.*` activity event as its own `m.notice` — it spammed
the timeline, and `tool_call_update` posted a new message instead of editing the
original. Now:

- A turn that touches tools gets **one** threaded `m.notice` (e.g.
  `🔧 architect: Read file — in_progress · 2 tools`), edited in place with
  `m.replace` as activity arrives and finalized on turn end to
  `✅ N tools · M files` (`⚠️ N tools · M files` when the turn failed).
  `tool_call`, `tool_call_update`, `plan` and `available_commands_update` are
  folded into it and no longer mirrored individually. A turn with none of that
  activity gets no line at all — the prose is already a message.
- `approval_request` and `error` stay standalone notices: they are actionable
  and must remain visible. The raw `dev.zooid.*` custom events are unchanged
  (the Zooid client, and Element's "show hidden events", still see them).
- The line carries a `dev.zooid.mirror: true` marker so a client that renders
  the native events (the Zooid web client) can hide it; stock Element ignores
  the unknown field and shows the line.
- Edits are idempotent (a body equal to the last applied one is skipped) and
  graceful when the target is gone (a redacted/missing original is recreated so
  the summary is not lost).
