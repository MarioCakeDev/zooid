# Fork delta vs upstream

This branch (`feat/upstream-0.17-migration`) merges `upstream/main` @ `d7b44534`
(zooid packages **0.17.0**) into our fork, whose prior deployed revision was
`141cb8b` (`origin/feat/typed-interrupt`, based on upstream
`feat/typed-interrupt` @ `c05231e`).

Everything below is a **fork-only** difference that survives the merge. Upstream
0.17.0's own new features (structured `zooid_handoff`, ACP form elicitation, ACP
session lifecycle / `session_idle_timeout`, `acp.mode`, remote-workstation
roster, `workforce_space`, trigger `messages[]`) are upstream's and are not
listed here.

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

- `packages/context-mcp/src/bin.ts`, `daemon-socket.ts` — connect the MCP stdio
  transport *before* the daemon role query, and retry once on a connect-phase
  failure (cold-connect race) without ever re-sending a request that reached the
  server.
- `packages/context-mcp/src/mcp-server.ts` — `registerTaskTools` split out so read
  tools are live before the role query lands.
- `packages/transport-matrix/src/context-provider.ts` — resolve room names and
  survive cross-room thread ids (top-level fallback on
  `Relations must be in the same room`).
- `packages/transport-matrix/src/matrix-client.ts` — carry the homeserver body
  on send failures so callers can tell actionable errors from transient ones.
- `packages/transport-matrix/src/transport.ts` — `resolveThreadRoot` relation-chain
  walk (never root a thread on an event that itself carries a relation).

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
