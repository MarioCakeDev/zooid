---
'@zooid/transport-matrix': patch
---

Element mirror: stable tool icons and a literal `>_` mark for shell calls

Two tagline fixes:

- A `tool_call_update` no longer overwrites the tool entry's display title.
  opencode's completed frame replaces the ACP `title` with a runtime display
  string (bash → the command, edit/write → the file path, todowrite →
  "0 todos"), and `toolIcon` reads the title's first word, so forwarding it
  made bash/edit/write/todowrite fall back from their real emoji to 🛠. The
  update's title is still passed to the write/create diff fallback, so writes
  keep rendering as a diff.
- Shell tools (`bash`, `shell`, `ssh`, `exec`, `terminal`, `run`) now render
  with the literal `>_` mark instead of 🐚.
