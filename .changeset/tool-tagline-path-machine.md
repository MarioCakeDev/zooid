---
'@zooid/transport-matrix': patch
---

Mirror taglines: file path and machine, no status words

Each tool's mirror line drops its `— done` / `— failed` / `— running` /
`— pending` suffix — the leading glyph (✓ ✗ ⏳ •) already carries the status —
and gains the two facts a glance is actually after:

- Read/write tools show the file path instead of the tool word
  (`✓ 📖 /workspace/AGENTS.md`, `✓ ✏️ /workspace/src/x.ts`), read from the ACP
  `rawInput` path keys (`filePath`/`filepath`/`file_path`/`path`) or the event's
  first `locations[].path`.
- Shell calls name the machine they ran on: the ssh-mcp `profile`
  (`✓ 🐚 ssh_run-command @coolify`), else `host`/`hostname`, else `local` for a
  call with no machine in its event (bash inside the agent container). No
  hostname is ever invented.

The group summary uses the same rendering for its last tool minus the status
glyph (`🔧 dev: 1 tool — 🐚 bash @local`), so the plain body and the HTML
`<summary>` cannot drift. Params/output blocks, every clamp, HTML escaping and
plain/HTML parity are unchanged.
