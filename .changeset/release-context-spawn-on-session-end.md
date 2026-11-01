---
'@zooid/context-mcp': patch
'@zooid/core': patch
'zooid': patch
---

Release a session's context spawn when its ACP session ends

`SpawnRegistry.release()` existed but had no production caller, so every spawn
an agent had ever had stayed bound for the daemon's whole life. opencode keeps
ACP `session/new` `mcpServers` in a directory-scoped registry and never removes
them when the session closes (anomalyco/opencode#40978), so those stale
`zooid-context-<spawnId>` servers stayed advertised to every session in the
container — and a call through one acted with the dead session's room, thread
and task. That is the cross-thread leak seen live.

- `SpawnRegistry.releaseSession(agentName, sessionKey)` releases exactly the
  binding an ACP session owns, leaving other threads/agents alone.
- `AcpAgentRegistry` now reports session ends (`onSessionEnded`): an idle close
  (`closed`/`failed` lifecycle) and `endSession()` (`/clear`, reset, handoff-arc
  cleanup). An `unsupported` idle close keeps the session alive, so its binding
  is retained.
- `buildAcpRegistry` wires that to `SpawnRegistry.releaseSession`, so a released
  spawn's tools fail loudly with the daemon's existing `binding not owned by
  caller` instead of acting.

Also rejects a whitespace-only `zooid_complete_task` summary
(`z.string().trim().min(1)`); `"   "` previously passed `min(1)`.
