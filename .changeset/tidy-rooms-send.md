---
'@zooid/core': patch
'@zooid/transport-matrix': patch
'@zooid/context-mcp': patch
---

sendMessage: resolve room names/aliases and survive cross-room thread ids

`zooid_send_message` required a full canonical room id and hard-failed with a
bare `400 Relations must be in the same room` when the `thread_id` belonged to
a different room than the target. Now:

- `room` accepts a room id, alias (`#review` / `#review:server`), or the
  display name from `zooid_get_rooms`; it is resolved against the agent's own
  bound rooms, and anything not bound still fails `not_in_room`.
- a `thread_id` whose root event is not in the target room is dropped and the
  message is posted top-level, with a `warning` on the result, instead of
  surfacing the homeserver's 400.
- `MatrixClient.sendEvent` now includes the homeserver response body in its
  error so relation mismatches can be told apart from transient failures.
