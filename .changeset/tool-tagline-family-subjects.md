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
  another. The icon names the family, and the family prefix is stripped from the
  verb so the specific action still reads:
  - 🐙 GitHub — `search_code <query>`, `get_file_contents owner/repo:path`,
    `issue_read owner/repo#number`, `get_commit owner/repo@ref`,
    `create_pull_request owner/repo head→base`, `get_teams user`, else
    `owner/repo`.
  - ☁️ Coolify — `deploy <tag_or_uuid>`, `logs <uuid>/<container>`, the tag
    names for a tag call, any resource uuid, else id/name/key/command, else
    `action resource`/`action provider`.
  - 💾 TrueNAS — `create_snapshot tank/data`, else dataset/user/share/pool/id.
  - 🔑 Pocket ID — `oidc_client_update <id>`, else id/name/username/email/search.
  - 🏠 Home Assistant — `HassTurnOn Küchenlicht`, else area/item/entity_id/
    message/query or a reported observation.
  - 💬 zooid/Matrix — `send_message <room>`, else thread/name.
  - `>_` ssh — a command as before; with no command, `sftp-list <path>`,
    `signal-process <signal> <pid>` or the session.
  - 🔍 grep / 🗂 glob — the pattern; 📝 todowrite — `N todos`; 🤖 task — the
    description; 🤖 skill — the name.

A call that carries nothing to name falls back to the family-stripped verb (or
the bare title for non-family tools) exactly as before. Numeric args
(issue/pull numbers, pids) are now recognised. Clamps, HTML escaping, plain/HTML
parity and the group summary are unchanged.
