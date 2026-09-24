---
'@zooid/transport-matrix': patch
---

Element mirror v3: collapsible details, last-activity summary, append-only tool list

Builds on v2's single editable per-turn line. The line is now a collapsed
`<details>` block rendered by stock Element, so a turn with many tools stays one
glanceable line instead of a summary that overwrites itself.

- `<summary>` is the **last activity**: `🔧 <agent>: <tool title> — <status>`
  (e.g. `🔧 dev: bash — running`, `🔧 dev: edit src/x.ts`). On turn end the
  summary is **finalized** to `✅ <agent>: done · N tools · M files`
  (`⚠️ <agent>: failed · …` when the turn threw) — the chosen finalize rule is
  replacement, not a "last tool + done marker" suffix.
- The body is an **append-only list**, one compact line per tool in first-seen
  order, newline-separated with `<br>`: `✓ bash — done`, `⏳ edit src/x.ts`,
  `✗ edit — failed`, `• Read file` for a statusless tool. A new `tool_call_id`
  appends an entry; a later `tool_call_update` for the same id mutates that
  entry in place (title, status) and never appends a duplicate.
- **Titles + status only — never raw tool output.** A `tool_call_update`'s
  `content[]` text is not folded into the line; long titles are clamped.
- The list is **bounded**: at most 50 entries and an 8000-char rendered budget,
  with the overflow collapsed into a single `… +K more` line, so a turn with
  hundreds of tools cannot push the notice past the homeserver's event-size cap
  (which would silently swallow the `m.replace`). An orphan
  `tool_call_update` — one whose `tool_call_id` has no prior `tool_call` — is
  titled `tool` rather than the opaque raw id.
- The `<details>` has no `open` attribute and `<summary>` is its first child, so
  Element renders it collapsed. `msgtype` stays `m.notice` and the
  `dev.zooid.mirror` marker is preserved in the create and every `m.replace`
  edit.
- `body` is the plain-text summary line (the fallback for a client without HTML
  rendering); `formatted_body` carries the details block with HTML-special
  characters escaped.
- No regression: `approval_request` and `error` remain standalone notices; a
  prose-only turn still gets no line; interactive approvals are unchanged.
