---
'@zooid/acp-client': patch
'@zooid/core': patch
'@zooid/runtime-docker': patch
'@zooid/transport-http': patch
---

One ACP process per conversation, idle-reaped — makes the MCP-registry leak structurally impossible

`AcpAgentRegistry` used to keep **one `AcpClient` (one `opencode acp` process)
per agent**, so every thread of that agent shared one process — and therefore
one directory-scoped MCP registry. opencode never removes a closed session's
`session/new mcpServers` from that registry (anomalyco/opencode#40978), so a
stale `zooid-context` server stayed advertised to every later session and a
call through it acted on a dead session's room/thread/task. #48 stopped those
stale bindings from *acting*; this change stops them from being visible at all.

- The registry now keys processes by **conversation** (the session key the
  transport already passes to `ensureSession`: the thread id for a thread-level
  turn, the composed `thread|call` key for a handoff arc) and reuses each
  process for that conversation's turns. One process ⇒ one live ACP session ⇒
  its tool catalog can only ever contain its own `zooid-context` server.
- Container runtimes get a per-conversation identity (`AcpSpawnSpec.spawnKey`):
  `DockerAcpRuntime` names the container `zooid-agent-<agent>-<12-hex>` and
  reaps only that exact name. Without it, spawning a second thread would
  `docker rm -f` the first thread's live container.
- Idle reaping: a process with no turn, pending approval/elicitation or close
  in flight is closed (`session/close`, keeping the persisted pointer) and
  killed after `agents.<name>.process_idle_timeout` (default 5m, `0` disables).
  Reaping is skipped while the adapter cannot `session/resume`/`session/load`,
  because killing it would silently drop the conversation.
- `endSession` (`/clear`, reset, handoff-arc cleanup) now stops that
  conversation's process immediately; `cancelSession` (`/interrupt`) finds the
  one process that owns the ACP session id.
- One shared `sessions.json` store per agent, injected into every
  per-conversation client — independent stores on the same path would each
  rewrite the whole file from their own map and drop the other threads'
  pointers.
- Failure isolation, per conversation: a wedge retires and replays **only that
  thread's process** (others keep running); a process that fails to start or
  dies within 60s three times in a minute opens a circuit for a 30s–10m
  backoff instead of respawning in a hot loop. Neither path affects the agent's
  other threads.
- The HTTP transport mints one conversation per `POST /agents/:name/sessions`
  and cannot resume it, so it now ends that session when the turn is over
  (releasing its context spawn and stopping its process) instead of leaving one
  idle process per request for the reaper.

Agents still fan out whatever MCP servers their `opencode.json` declares; a
deployment that puts one process per thread must give that process a slim
server set (remote servers + `poll`) or the per-thread multiplicity dominates
memory. That is configuration, not something this patch can enforce.
