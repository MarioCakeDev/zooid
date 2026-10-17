---
'@zooid/transport-matrix': patch
'@zooid/core': patch
---

`zooid_send_message` accepts a bound room by its configured alias (`#room:server` or bare `#room`) as well as its canonical ID. `BotPool.bootstrap` now keeps the configured selector on the binding (`configuredAlias`) when it rewrites `alias` to the room ID, and `not_in_room` lists the rooms the agent is in.
