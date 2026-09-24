---
'@zooid/transport-matrix': patch
---

Mirror blocks: collapsible `<details>` groups with tool params and output

Each prose-gap mirror group is now a collapsible Element block instead of a flat
list of tool lines. The plain `body` fallback carries the same content
`\n`-joined (what Element X and non-HTML clients show); the `formatted_body`
wraps it in `<details><summary>…</summary>…</details>` with no `open` attribute,
so Element Web/Desktop renders it collapsed and Element X shows the body
expanded.

- `TurnToolEntry` now also holds the tool's compact ACP `rawInput` (`params`) and
  the latest `tool_call_update` `content[]` text (`output`). `upsertGroupEntry`
  merges both from `tool_call` / `tool_call_update`, so an update refreshes the
  same entry in place — never a duplicate.
- The group summary is `🔧 <agent>: <N tools> — <last tool> — <status>` (the
  first line of the plain body and the `<summary>`); the body is one section per
  tool in first-seen order — the tool line (`✓ bash — done`), its params on a `⚙`
  line, its output on `↳` lines — then the plan detail.
- Caps: params and output are each clamped (200 chars — output per `content[]`
  entry and in total), the group keeps its last 20 entries (`… K more` for the
  hidden remainder) and is bounded by an 8 KB escaped-body budget, so nothing
  unbounded is resent on every `m.replace`. The newest entry is always kept, even
  if it alone exceeds the budget, so the tool named in the summary never vanishes
  from the body. Every interpolated value is HTML-escaped.
- The `dev.zooid.mirror` marker, the thread relation and the edit shape are
  unchanged in both the fallback and `m.new_content`.
