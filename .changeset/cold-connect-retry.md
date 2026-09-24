---
'@zooid/context-mcp': patch
---

Cold-connect: bring the MCP transport up before the daemon role query

A fresh session's first room-scoped tool call could fail with `Not connected`.
The context-mcp bin awaited a daemon `describeRole` round-trip **before**
`server.connect()`, so on a cold session (daemon recreating, socket slow) the
agent's first call reached the MCP SDK with no transport attached. Only a manual
retry worked.

- `bin.ts` now connects the stdio transport first; the read tools are live at
  once and the role query runs afterwards. An allowed role registers the task
  tools on the connected server, which the SDK announces with
  `notifications/tools/list_changed`.
- `callDaemon` retries once when the connection could not be established (the
  listener is briefly absent during a daemon recreate). A request that reached
  the server is never retried, so `sendMessage` cannot be delivered twice.
