---
'@zooid/transport-matrix': minor
---

Element mirror: all tool calls since the last prose on one line

v3 folded a turn's whole tool activity into one collapsed `<details>` notice,
posted at the first tool and edited in place — quiet, but it sits at the first
tool's position, so the timeline no longer shows what ran between which prose
messages. A first cut posted one line per tool, which made long turns noisy.

Now every run of tool/plan activity between two prose messages is **one**
threaded `m.notice`, posted the moment the first activity happens and edited in
place as more tools run:

- consecutive tool calls with no prose between them share one line
  (`🔧 dev: ⏳ bash · ✓ edit src/x.ts — done`); a `tool_call_update` edits the
  entry in place, so a `tool_call_id` maps to exactly one line and updates never
  add a line;
- a prose message closes the group, so the next tool starts a new line — the
  timeline reads prose → tool line → prose → tool line and the order of
  execution is clear;
- a `plan` joins the same line as its gap's tools (`· 🗒 plan (2 steps)`);
  `available_commands_update` is session metadata and is not mirrored;
- an orphan `tool_call_update` (an id never seen as a `tool_call`) is ignored —
  it carries no title, so it could only produce a useless raw-id line `• tc-1`;
- turn end posts one `✅ <agent>: done · N tools · M files` line
  (`⚠️ … failed`); the counts are distinct tools, not lines; a turn with no
  tool/plan activity still gets no line.

Each line carries the `dev.zooid.mirror` marker, so the router guard still drops
it as a mention and the Zooid web client can hide it. `approval_request` and
`error` stay standalone. The raw `dev.zooid.*` custom events are unchanged.
