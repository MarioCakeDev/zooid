---
'@zooid/context-mcp': patch
---

Log a failed describeRole to stderr with the socket path. When the socket itself is unreachable (not when the daemon answers with an error), also tell the agent so (instructions notice + zooid_context_status tool) instead of silently dropping the task tools.
