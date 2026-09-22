---
'zooid': patch
---

Recover from a dead/recreated agent container instead of hanging the daemon.

The ACP handshake (`initialize`, `loadSession`/`newSession`) is now bounded by a
timeout and races the child's `exit`/`error`, so a wedged or replaced container
fails the dispatch with a real error (surfaced to the room as `dev.zooid.error`)
rather than blocking `ensureSession` forever. `AcpClient` reports liveness and
the registry drops and reconnects a dead cached client. The Docker runtime now
gives each agent a deterministic `--name zooid-agent-<id>` + `zooid.agent=<id>`
label and reaps any stale container with that name before spawning, so duplicate
agent containers can no longer accumulate across daemon restarts.
