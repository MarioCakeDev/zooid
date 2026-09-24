---
'@zooid/transport-matrix': patch
---

Never route the transport's own mirror notices as mentions

A transport display mirror (`dev.zooid.mirror`) echoes tool activity and error
text verbatim, and a context-MCP result such as `zooid_get_history` quotes old
messages — including their `@agent` mentions. The raw-text mention fallback in
`extractMentions` picked those up, so a marked mirror line could wake an agent
(or a peer) in a loop with no actual question.

- `route` skips any `m.room.message` carrying the marker, including `m.replace`
  edits where it is repeated in `m.new_content`. Real prose that quotes a
  mention still routes as before.
- Every transport-generated notice carries the marker, including the standalone
  `dev.zooid.error` / `dev.zooid.approval_request` notices from
  `sendMirrorNotice` (their bodies quote error text and tool titles).
- `rebuildThreadState` applies the same guard, so a quoted mention in a mirror
  can no longer re-seed a phantom root-mention or caller edge on the restart /
  self-heal and `/clear` paths.
