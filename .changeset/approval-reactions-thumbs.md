---
'@zooid/transport-matrix': patch
---

Approval reactions: use 👍/👎 instead of ✅/❌

Stock-client approvals were answered with ✅ (approve) and ❌ (deny). Those keys
collide with the ✅/⚠️ glyphs the per-turn mirror line already uses for turn
outcomes, so a reaction and a status glyph looked alike in the timeline. The
canonical reaction keys are now 👍 and 👎.

- `APPROVE_REACTION` is `'👍'`, `DENY_REACTION` is `'👎'`; the mapping is still
  deliberately narrow (no aliases) and the retired ✅/❌ keys no longer resolve.
- The stock-client hint and the reaction-handling docs now name 👍/👎.
- The `approve <id>` / `deny <id>` and bare `approve` / `deny` message paths, the
  bot-sender guard, and resolve-once idempotency are unchanged.
