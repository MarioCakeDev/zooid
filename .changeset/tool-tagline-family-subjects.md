---
'@zooid/transport-matrix': patch
---

Element mirror: websearch quotes its keywords; every tool family names its subject

A tool tagline is `status icon subject`; until now only read/write (path), shell
(command + machine) and web-fetch (URL) tools said *what* they acted on — every
other tool stopped at its bare name (`🐙 github_get_file_contents`).

- **Web search** now shows the keywords instead of the tool word: the globe
  already says "went to the web", so `websearch` (with a `query`/`q`) renders as
  `🌐 zooid websocket docs`. A search with no query keeps the title.
- **Family subjects** add the one argument that distinguishes one call from
  another, keyed by the tool title's first word:
  - 🐙 GitHub — search query, `owner/repo:path`, `owner/repo#number`,
    `owner/repo@ref`, a PR `head→base`, `owner/repo@branch`, else `owner/repo`.
  - ☁️ Coolify — `tag_or_uuid`/`uuid` (with `/container` for logs), else
    id/query/name/key, else the control `action resource`.
  - 💾 TrueNAS — dataset/snapshot, else username/share/path/pool/id.
  - 🔑 Pocket ID — id/name/username/email/displayName/friendlyName/search.
  - 🏠 Home Assistant — name, else area/item/entity_id/floor/message/query.
  - 💬 zooid/Matrix — room or thread, else name/text.
  - `>_` ssh — a command as before; with no command, the path/session/pid.
  - 🔍 grep / 🗂 glob — the pattern; 📝 todowrite — `N todos`; 🤖 task — the
    description; 🤖 skill — the name.

Titles are preserved in front of the extracted argument for the many-verb MCP
families (so `deploy <uuid>` still reads as a deploy), and a call that carries
nothing to name falls back to the bare title exactly as before. Numeric args
(issue/pull numbers, pids) are now recognised. Clamps, HTML escaping, plain/HTML
parity and the group summary are unchanged.
