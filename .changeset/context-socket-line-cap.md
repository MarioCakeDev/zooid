---
'@zooid/context-mcp': patch
---

The per-agent context socket now rejects a request line longer than 1 MiB without a newline: it replies with an error and closes the connection instead of buffering it without bound.
