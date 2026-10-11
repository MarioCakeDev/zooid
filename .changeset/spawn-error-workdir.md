---
'@zooid/acp-client': patch
'@zooid/runtime-local': patch
---

A runtime child that fails to spawn now fails the turn instead of crashing the daemon, and `runtime: local` creates a missing agent workdir before spawning.
