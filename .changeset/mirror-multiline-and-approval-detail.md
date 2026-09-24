---
'@zooid/transport-matrix': patch
---

Mirror lines: one tool per line (HTML), and approval notices that say what will run

The per-turn tool/plan mirror line joined every entry with ` · ` on a single
plain-text line. Stock clients — Element X on Android in particular — render a
bare `\n` as one run-on line, and the body carried no HTML at all, so there was
no way to get separate lines.

- `turnGroupBody` now joins the entries with `\n` (the `🔧 <agent>:` prefix stays
  on the first line) and the new `turnGroupHtml` renders the same lines joined
  with `<br>`. `turnMirrorNoticeContent` / `turnMirrorEditContent` carry that as
  `format: 'org.matrix.custom.html'` + `formatted_body` on the create and in
  `m.new_content`, HTML-escaping each title/status. The plain `body` stays the
  plaintext fallback (now `\n`-joined, where it used to be one ` · `-joined
  line); the `dev.zooid.mirror` marker, the thread relation and the edit shape
  are unchanged. One group is bounded to its last 20 lines, with the hidden
  remainder summarised as `… K more`, so a long turn cannot grow the notice (and
  every edit that resends it) without limit.

- The approval notice no longer advertises `reply "approve <id>" or "deny <id>"`
  (the message path still works, just unadvertised) and now names the actor and
  the action: `🔐 infra wants to run: <command> — react 👍/👎` or
  `🔐 dev wants to edit: <path> — react 👍/👎`, rendered from `tool_kind` /
  `tool_title` / `tool_input` and clamped. The correlation/idempotency and the
  single `m.notice` shape are unchanged.
