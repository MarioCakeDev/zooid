---
'@zooid/context-mcp': patch
---

Log a failed describeRole to stderr with the socket path, and tell the agent the context daemon is unreachable (instructions notice + zooid_context_status tool) instead of silently dropping the task tools.
