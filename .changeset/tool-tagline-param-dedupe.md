---
'@zooid/transport-matrix': patch
---

Element mirror: drop taglined arguments from the params block

A tool's input block no longer repeats an argument the tagline already shows.
The family extractors now return the raw-input keys they consumed, and
`entryParams` filters those keys out of `toolParamsText` (alongside the diff's
own keys when a diff renders), so e.g.:

- `bash` shows the command on the tagline and no `command=…` line below;
- an `edit`/`write` shows the path on the tagline and no `filePath=…` line;
- `github_get_file_contents owner/repo:path` drops `owner`/`repo`/`path` from
  the params (a lingering `ref` still shows);
- `ssh_run-command` drops `command` and `profile`;
- a web search drops `query`; a `grep` drops `pattern`; a `todowrite` drops
  `todos`.

The machine key (`profile`/`host`/`hostname`) is dropped only when the tagline
actually carries the `@machine` suffix. A tool left with nothing to show renders
as its bare tagline (no empty params block). Diff keys, clamps, HTML escaping and
plain/HTML parity are unchanged.
