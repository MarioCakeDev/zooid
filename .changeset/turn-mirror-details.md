---
'@zooid/transport-matrix': patch
---

Element mirror v3: collapsible per-turn tool details

v2 folded a turn's activity into one editable `m.notice`, but the line was
opaque: it only showed the latest activity, so a turn that ran ten tools looked
like a single tool.

The notice now renders a collapsed `<details>` block. `<summary>` is the latest
activity (`dev: bash — running`), and the body is an append-only list with one
compact line per tool (`bash — done`). A new `tool_call_id` appends an entry; a
later `tool_call_update` for the same id mutates that entry in place, never a
duplicate. On turn end the summary is finalized to `dev: done · N tools · M files`
(`failed`).

This also stops folding raw tool output into the summary: tool activity is
rendered from its own entry, so a context-MCP result that quotes a long history
no longer replaces the whole line's detail with opaque content text.

The raw `dev.zooid.*` events are still sent, so the Zooid web client is
unaffected. Routing the mirror as a mention is handled separately (#6).
