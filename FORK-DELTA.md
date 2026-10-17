# Fork delta vs upstream

> **AI-only fork.** This repository is maintained **exclusively by the Zooid AI
> agent workforce** (`MarioCakeDev/MatrixAgent`). Changes are AI-generated, are
> not held to upstream review standards, and may be experimental or broken; this
> fork is not intended for humans, general use, or redistribution. **Do not
> depend on this fork.**

This branch (`merge/upstream-0.18.0`) merges `upstream/main` @ `55a51bd0`
(zooid packages **0.18.0**) into our fork `main`, whose merge base was
`d7b44534` (upstream **0.17.0**); the fork's previous merged revision was
`a9b04665`.

Everything below is a **fork-only** difference that survives the merge. Upstream
0.18.0's own work (per-agent `runtime:` + the new `vm` runtime,
`runtime-resolve.ts` / `provision-vms.ts`, `dev.zooid.turn.end` `turn_id` +
`stop_reason`, the typing registry, thread-history `has_more`, recent-threads
batching, the `createRoom` creator retry, the `zooid_send_message` bound-room
alias, `describeRole` surfacing in context-mcp, the socket line-buffer cap,
`acp-client` spawn-error/workdir handling, and the `scripts/tier-*.mjs` CI
tiering) is upstream's and is not listed here.

Regenerate with `git log --oneline upstream/main..HEAD`.

---

## 1. Element mirror (our headline feature)

Every agent turn is rendered in stock Matrix clients as a **single editable
`m.notice` line** per prose→tool group: created on the first tool/plan activity,
edited in place via `m.replace` as more tools run, and finalized with a summary
(`✅ dev: done · N tools · M files` / `⚠️ … failed`). Each tool is a collapsible
`<details>` with params, output, and a **unified diff** for file writes; tool
taglines carry an icon, a path and a machine. Every mirrored event is marked
(`TURN_MIRROR_MARKER` = `dev.zooid.mirror`) so routing and restart-rebuild never
treat a quoted `@agent` as a mention. (Our fork's earlier @mention-handoff
machinery was removed — see section 6.)

Modules:

- `packages/transport-matrix/src/event-encoders.ts` (+ `.test.ts`) — mirror/notice
  bodies and HTML, tool taglines/icons, `<details>` renderer, `TURN_MIRROR_MARKER`,
  `toActivityNoticeBody`, `turnGroupBody`/`turnGroupHtml`, `turnFinalBody`,
  `turnMirrorNoticeContent`/`turnMirrorEditContent`, `toolCallDiff`/`DIFF_PARAM_KEYS`.
- `packages/transport-matrix/src/unified-diff.ts` (+ `.test.ts`) — unified diff
  engine for writes.
- `packages/transport-matrix/src/transport.ts` — the per-turn mirror state machine
  (`updateTurnMirror`, `finalizeTurnMirror`, `closeMirrorGroup`) and its hooks.
- `packages/transport-matrix/src/router.ts` — `isMirrorNotice` guard so a mirror
  notice never routes as content or seeds mentions on rebuild.

## 2. Interactive approvals via reactions

Approvals render as an actionable notice and are answered from any client:
👍/👎 reactions on the approval custom event *or* its mirrored notice, or an
`approve <id>` / `deny <id>` (bare `approve`/`deny` in the approval's own thread)
message. Option selection and the value→option mapping are validated; agents may
not approve their own or each other's requests.

Modules:

- `packages/transport-matrix/src/approval-commands.ts` (+ `.test.ts`) —
  `parseApprovalCommand`, `reactionCommand`, `decisionForCommand`, `isApprovalId`.
- `packages/transport-matrix/src/transport.ts` — correlation maps
  (`approvalByEvent` / `approvalMeta`), `handleApprovalReaction`,
  `maybeHandleApprovalMessage`, `postApprovalNotice`.
- `packages/core/src/approval-correlator.ts` — `resolveById` / `get` and a
  `'resolved'` event so transports can drop correlation state.

## 3. Interrupt: typed `/interrupt` and bare `stop`/`stopp`

A human in a stock client can cancel a running task without the custom event:
`/interrupt`, `/interrupt@<agent>`, or a bare `stop`/`stopp` cancels every live
session bound to the thread and closes your own in-flight approval/elicitation.
An in-thread `⏹ interrupted by <user>` notice acks it (marked as a mirror so it
never wakes an agent again). The `dev.zooid.interrupt` custom-event path and the
typed path share `interruptThread`.

Module: `packages/transport-matrix/src/transport.ts` (`INTERRUPT_COMMAND_RE`,
`INTERRUPT_STOP_RE`, `isInterruptTrigger`, `interruptThread`,
`postInterruptNotice`, `maybeHandleInterruptMessage`).

## 4. ACP resilience

Two failure classes upstream does not handle, both fatal before this fork:

- **Dead agent container / child** — `AcpClient` watches the spawned child and
  marks itself dead on exit/error (`isAlive()`, `markDead`, `watchChild`). The
  registry (`AcpAgentRegistry.ensureClient`) drops a dead cached client and
  reconnects instead of hanging every later dispatch. Handshakes run under
  deadlines (`withDeadline`: `initializeMs`, `sessionMs`) so a recreated
  container fails instead of blocking.
- **Wedged resumed session (silent prompt loss)** — a session resumed across a
  restart can accept a prompt and never answer. A **first-response deadline**
  (`withFirstResponse`) is disarmed by any real update (not
  `available_commands_update`); when it elapses the session is invalidated in
  memory and in the persisted store, the client is marked dead, and the registry
  replays the prompt once on a fresh session (`maxPromptAttempts`,
  `onSessionRekey`, `session_wedge` event). Transports re-key per-session state
  and post a visible wedge notice.

Modules:

- `packages/acp-client/src/acp-client.ts` — resilience + upstream elicitation /
  lifecycle, integrated.
- `packages/acp-client/src/errors.ts` — `AcpSessionWedgeError`, `isSessionWedge`,
  `classify`.
- `packages/acp-client/src/index.ts`, `packages/acp-client/src/types.ts`,
  `packages/acp-client/src/event-mapping.ts` — exports and title forwarding.
  `PromptResult` carries **both** the fork's `sessionId` (the session the turn
  actually ran on, so callers re-key after a wedge replay) and upstream's
  `turnId` (`dev.zooid.turn.end`).
- Tests: `acp-client.resilience.test.ts`, `acp-client.wedge.test.ts`,
  `packages/core/src/acp-registry.wedge.test.ts`,
  `packages/transport-matrix/src/transport.wedge.test.ts`,
  `packages/transport-http/src/server.wedge.test.ts`.
- `packages/core/src/acp-registry.ts` — dead-client replacement, start
  dedupe (`starting`), max-attempts validation, per-agent timeout override.
- `packages/core/src/config.ts`, `packages/core/src/types.ts`,
  `packages/core/src/acp-types.ts` — `first_response_timeout` config and
  `agentId` on the spawn spec.
- `packages/runtime-docker/src/docker-acp.ts` — deterministic per-agent
  container name/label, reaping a stale container before spawn (the dead
  container half).
- `packages/core/src/approval-correlator.ts`, `packages/transport-matrix/src/transport.ts`,
  `packages/transport-http/src/server.ts` — wedge notices and session re-key.

## 5. Other fork-only changes

- `packages/context-mcp/src/bin.ts`, `daemon-socket.ts` — register the task tools
  **unconditionally**, with the MCP stdio transport connected *first* (read tools
  live immediately). The daemon is the authorization boundary and refuses every
  disallowed task call per request (`depth_limit`, `no_open_task`,
  `unknown_caller`, `self`, `already_open`), so the MCP does not pre-screen. The
  fork previously gated registration on a one-shot `describeRole` snapshot taken
  at spawn, with the error swallowed and no retry: a single raced or failed
  query (e.g. `binding not owned by caller` during the spawn window) hid
  `zooid_start_task_threads` for the whole MCP lifetime, because the snapshot was
  never refreshed.
  One `describeRole` probe is still made, but **bounded** (`probeRole`, 250 ms
  deadline) and used only for upstream's *unreachable* surfacing: on a socket
  failure the server advertises `zooid_context_status` and the instructions carry
  the notice, so "daemon unreachable" is distinguishable from "tool missing". A
  probe that times out, or a daemon that answers with an error such as "task
  actions unavailable", leaves the tool list plain. `daemon-socket.ts` keeps the
  fork's cold-connect retry (`callDaemonOnce` + `neverConnected`, 50 ms)
  alongside upstream's `isTransportError` and the `MAX_LINE_LENGTH` buffer cap.
- `packages/context-mcp/src/mcp-server.ts` — `registerTaskTools` stays split out
  (read tools live before the task tools land), and the `role` parameter is kept
  for callers that want to pre-screen; production passes a permissive role and
  lets the daemon decide. Upstream's `roleError` support (the
  `zooid_context_status` tool plus the instructions notice) is kept as well.
- `packages/transport-matrix/src/context-provider.ts` — resolve room names and
  survive cross-room thread ids (top-level fallback on
  `Relations must be in the same room`). `resolveRoom` now tries upstream's local
  (homeserver-free) `resolveBoundRoom` match first — canonical room id, the
  `configuredAlias` a bootstrap rewrite preserved, or the bare `#localpart` the
  config normalizer expanded — and only then falls through to the fork's
  directory / display-name resolution. The membership refusal lists the bound
  rooms (`not_in_room: … Rooms this agent is in: …`), as upstream's does.
- `packages/transport-matrix/src/matrix-client.ts` — carry the homeserver body
  on send failures so callers can tell actionable errors from transient ones.
- `packages/transport-matrix/src/transport.ts` — `resolveThreadRoot` relation-chain
  walk (never root a thread on an event that itself carries a relation).
- `packages/transport-matrix/src/transport.ts` — the answered-elicitation typing
  re-arm is now upstream's typing registry (`typing.pause` when the card is
  posted, `typing.resume` in the request handler's `finally`), not the fork's raw
  `client.setTyping(…, 30_000)`. The fork's mirror-notice outcome edit
  (`editElicitationNotice` + `toElicitationOutcomeBody`) and `forgetElicitation`
  on `resolved` are unchanged, and the per-session re-key hook
  (`agents.onSessionRekey`) is kept.
- `.github/workflows/` — upstream's CI workflow updates are **intentionally not
  carried**. The fork's CI is external (built/deployed via Coolify), and pulling
  upstream `.github/workflows/*` would require a `workflow`-scoped token to push.
  Revisit when upstreaming. Re-apply the same exclusion on future upstream merges.
- `packages/transport-matrix/src/event-encoders.ts` (+ `transport.ts`) — Code
  Mode's `execute` tool gets a dedicated tagline: a `📜` icon
  (`TOOL_ICON_BY_NAME`) and the **whole** script rendered verbatim as its own
  multi-line block, instead of the collapsed, 200-char-clamped `code=…` param
  (`toolCodeText` / `CODE_TOOL_HEADS`, wired through `transport.ts`'s
  `entryParams`). Upstream treats every tool param as a compact one-liner. The
  script is also rendered so its line breaks survive: it is **fenced** in the
  plain `body` (markdown clients — e.g. Element X — soft-wrap a bare newline,
  squashing the script onto one line) and its HTML `<pre><code>` keeps
  **literal newlines** (`codeBlockHtml`, as for params/output). Real newlines
  are required: Element Web/Desktop counts `\n` for its line numbers and
  highlights from `textContent`, and Element X takes the `<pre>`'s `wholeText`
  — an explicit `<br>` contributes no character to either and collapses the
  script to one line. The `raw_input` string cap (`RAW_INPUT_STR_MAX = 250`) is
  also exempted for the Code Mode `code` argument (`clampRawInput`): that clamp
  exists to stop a big diff or file body bloating the notice, but it was
  truncating the script itself to `… [truncated]`.

## 6. Reconciliation note — our @mention handoff was removed

Our fork's old @mention-based handoff machinery (`registerOutgoingHandoffs`,
@mention-derived call edges, the circular-handoff guard on prose, and the
"@mention another agent to hand off" delivery text) was **removed** in favour of
upstream's structured `dev.zooid.handoff` / `zooid_handoff` model. After this
merge **agent @mentions do not wake agents** — `zooid_handoff` is the only
agent-involving path. `composeHandoffKey` / `callers` / `handoffs` /
`rootMentions` remain, but now carry upstream's structured-handoff (MXID-keyed)
semantics only.

Both config knobs coexist: `session_idle_timeout` (upstream lifecycle) and
`first_response_timeout` (our wedge detection).

## 7. Daemon-side patches (NOT in this repo)

The fork also carries two patches in `MarioCakeDev/zooid-daemon` (the
image/compose fork), which do not appear in this repository and must be kept in
that repo when the image is rebuilt:

- **`inhibit_login`** — appservice registration patch.
- **bootstrap retry** — retry daemon bootstrap on a transient failure.

## 8. Thread completion notice (opt-in)

Element X hides/lags threaded replies, so when a **directly-addressed** agent
finishes a turn, it posts exactly one **top-level** `m.text` — no `threadRoot`,
so no thread relation — **mentioning the author of the thread root** (a human,
or the agent that opened the thread) with a one-line summary and a `matrix.to`
permalink to the thread's latest message (HTML body so the link is tappable).
Everything else is unchanged.

Gated on **all** of: the feature is enabled for the agent; the turn is the
thread master (`sessionKey === threadRoot`); the thread has no `TaskRecord`
(not delegated); a mention target exists (a resolved root author, set at
promotion / recovered by `rebuildThreadState`, that is not a trigger-stamped
root, not the daemon/appservice bot, and not a configured trigger MXID); the
turn genuinely finished (no outstanding invocation, no pending human input, no
open handoff); it produced output; and it did not fail (a failed turn stays
silent — the in-thread mirror line already marks it). A handoff-arc
sub-session, task assignee, trigger/sweep/brief root, and an unresolvable root
never announce.

Config (default **off**):

```yaml
announce:
  thread_completion: true
  status_room: "#status"       # optional; alias / alias:server / display name / room id
# per-agent override (boolean only):
agents:
  infra:
    announce:
      thread_completion: false
```

`announce.status_room` redirects the notice to another room (canonically
`#status`); unset means the thread's own room. The mention target and the
permalink are unchanged — both still refer to the thread. The room reference is
resolved lazily via `MatrixClient.resolveAlias` (bare aliases expanded against
the transport's `serverName`, display names matched over bound rooms) and
cached; an unresolvable value logs a warning and falls back to the thread room
(the notice is never dropped).

Modules: `packages/core/src/{types,config}.ts` (`AnnounceConfig`, parse +
`mergeCliFlags` preservation); `packages/transport-matrix/src/event-encoders.ts`
(`matrixEventPermalink`, `threadCompletionContent`, `COMPLETION_NOTICE_MARKER`);
`packages/transport-matrix/src/router.ts` (`ThreadState.rootSender` /
`rootIsTrigger`, notice dropped by `route`); `packages/transport-matrix/src/transport.ts`
(`lastThreadEventId` capture, `announceThreadCompletion`, `resolveStatusRoom`);
CLI plumbing in `packages/cli/src/daemon/start-daemon.ts`.
