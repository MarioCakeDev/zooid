---
'@zooid/transport-matrix': patch
---

Approval reactions: normalise presentation modifiers before matching 👍/👎

Element and mobile clients append emoji presentation modifiers to a reaction
key — most commonly VS16 (U+FE0F), so the deny reaction arrives as the bytes
`f0 9f 91 8e ef b8 8f` (`👎` + VS16) rather than the bare `👎`. The approval
handler compared the key byte for byte, so the reaction was accepted as an
`m.reaction`, matched no command, and was silently dropped; the pending
approval was then cancelled when the next turn started.

`reactionCommand` now strips presentation-only modifiers before comparing:
variation selectors U+FE0E/U+FE0F, the zero-width joiner U+200D, and skin-tone
modifiers U+1F3FB–U+1F3FF. The mapping stays alias-free — only the canonical
👍/👎 keys resolve, and the retired ✅/❌ keys still do not.
