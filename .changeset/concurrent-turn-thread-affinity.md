---
'@zooid/context-mcp': patch
'@zooid/core': patch
'@zooid/acp-client': patch
'@zooid/transport-matrix': patch
'zooid': patch
---

Pin handoffs and returns to the turn that issued them under concurrency

On 2026-10-08 06:18 in `#infra`, two top-level triggers to the same agent were
dispatched concurrently. The handoff initiated while answering the first was
posted in the second thread and woke the second session; the first hung. Two
ambient-state resolutions, each across a concurrent-turn boundary:

- **context-MCP → daemon socket.** opencode registers ACP `session/new`
  `mcpServers` in a directory-scoped registry keyed by name
  (`mcp.add({directory, name, config})`), so two sessions of one agent that
  shared the name `zooid-context` had the later registration take over the
  earlier one: the earlier session's tool calls were served by the later
  session's process, whose spawn id and binding are its own. Each spawn now
  advertises a unique server name (`zooid-context-<spawnId>`, see
  `contextServerName`), so the two registrations coexist instead of colliding
  and each session's tool calls reach its own daemon binding. `SpawnRegistry`
  reuses the binding and spawn id for an existing `agentName::sessionKey`, so
  a session's name stays stable across re-registrations — opencode's same-name
  `storeClient` replace then closes the previous client instead of leaking an
  idle-close→resume orphan — while distinct session keys still get distinct
  names.
- **transport-matrix.** `deliverReturn` recomputed the recipient session from
  ambient thread state at release time, so a caller that entered a new handoff
  arc in the same thread between making the call and the return was woken on the
  new arc. `PendingReturns` now captures the caller's session key when the call
  is opened and delivers the return there.

The mirror's tool-family stripping handles the new per-spawn `zooid-context-…_`
title prefix.
