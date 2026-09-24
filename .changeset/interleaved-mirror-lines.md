---
'@zooid/transport-matrix': minor
---

Element mirror v4: interleave the tool/task lines with the prose

v3 folded a turn's whole tool activity into one collapsed `<details>` notice,
posted at the first tool and edited in place. That is quiet, but the collapsed
block sits at the first tool's position, so the timeline no longer shows what
ran between which prose messages — the order of execution is lost.

Now each tool call and each plan update is its **own** threaded `m.notice`,
posted the moment it happens, so the timeline reads prose → tool → prose → tool:

- a `tool_call` posts one line (`• Read file`, `⏳ bash`, `✓ bash — done`,
  `✗ edit — failed`); a `tool_call_update` edits that same line in place, so
  updates never add a line and a `tool_call_id` maps to exactly one line;
- a `plan` posts its own line (`🗒 plan (N steps)`); an
  `available_commands_update` is session metadata and is not mirrored;
- on turn end a final `✅ <agent>: done · N tools · M files` line closes the
  turn (`⚠️ … failed` when it threw); a turn with no tool/plan activity still
  gets no line at all.

Each line carries the `dev.zooid.mirror` marker, so the router guard still drops
it as a mention and the Zooid web client can hide it. `approval_request` and
`error` stay standalone. The raw `dev.zooid.*` custom events are unchanged.
