---
'@zooid/transport-matrix': patch
---

Never route the transport's own per-turn mirror notices as mentions

The per-turn display mirror (`dev.zooid.mirror`) echoes tool activity verbatim,
and a context-MCP result such as `zooid_get_history` quotes old messages —
including their `@agent` mentions. The raw-text mention fallback in
`extractMentions` picked those up, so a marked mirror line could wake an agent
(or a peer) in a loop with no actual question.

`route` now skips any `m.room.message` carrying the `dev.zooid.mirror` marker,
including `m.replace` edits where the marker is repeated in `m.new_content`.
Real prose that quotes a mention still routes as before.
