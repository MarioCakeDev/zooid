---
'@zooid/transport-matrix': patch
---

Never start a thread from an event that itself carries a relation

A top-level inbound message can be a reply (`m.relates_to: m.in_reply_to`) or
an edit (`m.replace`) from a stock client or the daemon's own mirror. The daemon
promoted any top-level event to its own thread root, so it then replied with
`m.relates_to: m.thread` pointing at an event that already had a relation.
Synapse rejects that with `400 M_UNKNOWN: Cannot start threads from an event
with a relation`, which broke every per-turn mirror create, the `dev.zooid.*`
activity events, and the agent's threaded prose.

The thread root is now resolved by walking the event's relation chain to the
first event the homeserver will accept: the thread root for an `m.thread`
relation, or the first relation-free ancestor for a reply/edit. The walk is
bounded and cached, falls back to the starting event when the chain cannot be
read (no room/member, fetch failure), and leaves ordinary top-level messages
and in-thread replies unchanged.
