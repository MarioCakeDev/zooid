import { Hono } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import type {
  AcpRegistry,
  ApprovalCorrelator,
  RegisteredApproval,
  TaskActions,
  PendingInputRegistry,
  StartTaskResult,
  StartTaskSpec,
  ThreadCompletion,
  ThreadStartContent,
} from '@zooid/core'
import { THREAD_RESULT_FIELD, THREAD_START_FIELD } from '@zooid/core'
import type { AgentEvent, ContentBlock } from '@zooid/acp-client'
import { MatrixClient } from './matrix-client.js'
import { BotPool } from './bot-pool.js'
import {
  route,
  isMediaMsgtype,
  isReturnRoute,
  wouldCycleCallers,
  type AgentBinding,
  type ThreadState,
} from './router.js'
import { sessionKeyFor, composeHandoffKey } from './session-keys.js'
import { stripMention, extractMentions } from './mentions.js'
import {
  toToolCallBody,
  toUpdateBody,
  toPlanBody,
  toAvailableCommandsBody,
  toErrorBody,
  toTurnEndBody,
  toActivityNoticeBody,
  activityDetail,
  createsTurnLine,
  toolSummaryDetail,
  renderTurnDetails,
  turnWorkingBody,
  turnFinalBody,
  turnMirrorNoticeContent,
  turnMirrorEditContent,
  type TurnToolEntry,
} from './event-encoders.js'
import {
  decisionForCommand,
  isApprovalId,
  parseApprovalCommand,
  reactionCommand,
  type ApprovalCommand,
} from './approval-commands.js'
import { classify } from '@zooid/acp-client'
import { toMatrixHtml } from './markdown-to-matrix-html.js'
import { PendingMediaStore, type PendingMediaItem } from './pending-media.js'
import { MediaClient, MAX_INLINE_IMAGE_BYTES, INLINE_IMAGE_MIMES } from './media-client.js'
import { writeAttachment } from './attachments.js'
import { SyncLoop } from './sync-loop.js'
import { NO_PENDING_INPUT } from '@zooid/core'
import { TaskRegistry, MAX_OPEN_TASKS_PER_ROOM, type TaskJournal, type TaskRecord } from './task-registry.js'
import { InvocationRegistry } from './invocation-registry.js'
import { evaluateCompletion, type StopReason } from './task-completion.js'
import {
  buildAssignmentContent,
  checkDelegable,
  renderCompletionPrompt,
  renderInvocationReturn,
  renderAssigneeEnvelope,
  renderDelivery,
} from './task-dispatch.js'

export interface MediaClientLike {
  download(input: {
    mxcUri: string
    asUserId: string
    maxBytes?: number
  }): Promise<{ data: Uint8Array; contentType: string }>
  upload(input: {
    data: Uint8Array
    contentType: string
    filename?: string
    asUserId: string
  }): Promise<{ content_uri: string }>
}

export interface CreateMatrixTransportOptions {
  agents: AcpRegistry
  approvals: ApprovalCorrelator
  client: MatrixClient
  bindings: AgentBinding[]
  hsToken: string
  /** Admin Matrix user ID. When set, BotPool.bootstrap invites this user into rooms it creates. */
  adminUserId?: string
  /** Post-turn drain: keep collecting trailing `agent_message_chunk`s until the
   *  buffer is quiet for this long before flushing. Defaults to `DRAIN_QUIET_MS`.
   *  Set to 0 to disable the drain (e.g. in tests). */
  drainQuietMs?: number
  /** Hard cap on the post-turn drain. Defaults to `DRAIN_MAX_MS`. */
  drainMaxMs?: number
  /** Injected media client for downloading/uploading Matrix media. */
  media?: MediaClientLike
  /** Injected attachment writer (defaults to the real writeAttachment). */
  writeAttachmentFn?: typeof writeAttachment
  /** AS sender-bot MXID (@<sender_localpart>:<server>). Together with the agent
   *  bindings this forms the set of "our bot users" whose ad-hoc invites are
   *  declined. */
  botUserId?: string
  /**
   * Transport ingestion mode.
   * - `'appservice'` (default): Tuwunel pushes events to the HTTP transaction endpoint.
   * - `'client'`: daemon polls via impersonated `/sync` per agent (pull mode).
   */
  mode?: 'appservice' | 'client'
  /** Pull mode: load the persisted `since` cursor for an agent user ID. */
  loadSince?: (agentUserId: string) => string | null
  /** Pull mode: persist the `since` cursor after each sync poll. */
  saveSince?: (agentUserId: string, since: string) => void
  /** Durable lifecycle state; supplied by the daemon when it has a data directory. */
  taskJournal?: TaskJournal
  taskRunId?: string
  pendingInput?: PendingInputRegistry
  /** Deferred-return fallback window. Defaults to `RETURN_GRACE_MS`. */
  returnGraceMs?: number
}

interface SessionContext {
  agent: AgentBinding
  roomId: string
  /** Always set — every session is thread-scoped via agent-promotion. */
  threadRoot: string
}

/** A callee's return to its caller, held until the callee's turn ends. */
interface PendingReturn {
  roomId: string
  threadRoot: string
  /** Last message of the turn so far; prompts the caller when released. */
  event: MatrixEvent
  /** Every chunk the callee posted this turn, in order. */
  texts: string[]
  /** Callers to wake, by agent name. */
  targets: Map<string, AgentBinding>
  timer?: ReturnType<typeof setTimeout>
}
interface TurnInput {
  roomId: string
  threadRoot: string
  sessionKey: string
  promptText?: string
  event?: MatrixEvent
  /**
   * Set only on the root turn of a task thread, for the assignee. Wraps the
   * computed promptText with `renderAssigneeEnvelope` in runTurn — later
   * turns in the same thread carry no envelope.
   */
  taskEnvelope?: { parentAgent: string }
}

interface MatrixEvent {
  type?: string
  event_id?: string
  origin_server_ts?: number
  room_id?: string
  sender?: string
  /** Present on state events (m.room.member → the affected user). */
  state_key?: string
  content?: Record<string, unknown> & {
    msgtype?: string
    body?: string
    membership?: string
    'm.relates_to'?: { rel_type?: string; event_id?: string }
  }
}

const STARTUP_GRACE_MS = 5_000

/**
 * How long a deferred return waits for the sending agent's `dev.zooid.turn.end`
 * before firing anyway. The turn.end always follows the turn's messages on the
 * wire, so this only matters when there is no turn behind them at all — the
 * daemon restarted mid-turn, or a human posted as the agent's user from a
 * plain Matrix client. Without it such a return would strand forever.
 */
const RETURN_GRACE_MS = 90_000

interface MediaBlocksResult {
  blocks: ContentBlock[]
  pathLines: string[]
}

async function buildMediaBlocks(
  items: PendingMediaItem[],
  opts: {
    agent: AgentBinding
    media: MediaClientLike | undefined
    writeAttachmentFn: typeof writeAttachment
    onError: (item: PendingMediaItem, err: unknown) => void
  },
): Promise<MediaBlocksResult> {
  const blocks: ContentBlock[] = []
  const pathLines: string[] = []

  if (!opts.media || items.length === 0) return { blocks, pathLines }

  for (const item of items) {
    try {
      const isInlineCandidate =
        item.msgtype === 'm.image' &&
        INLINE_IMAGE_MIMES.includes(item.info?.mimetype ?? '') &&
        (item.info?.size === undefined || item.info.size <= MAX_INLINE_IMAGE_BYTES)

      if (isInlineCandidate) {
        const { data, contentType } = await opts.media.download({
          mxcUri: item.url,
          asUserId: opts.agent.userId,
        })
        // Double-check actual size (info can lie)
        if (data.byteLength <= MAX_INLINE_IMAGE_BYTES) {
          blocks.push({
            type: 'image',
            data: Buffer.from(data).toString('base64'),
            mimeType: contentType,
          })
          continue
        }
        // Actual size exceeded cap — fall through to file route with the already-downloaded bytes
        if (opts.agent.workspaceDir) {
          const paths = opts.writeAttachmentFn({
            workspaceDir: opts.agent.workspaceDir,
            agentWorkspacePath: opts.agent.agentWorkspacePath ?? opts.agent.workspaceDir,
            eventId: item.eventId,
            filename: item.filename ?? item.body,
            data,
          })
          blocks.push({
            type: 'resource_link',
            uri: `file://${paths.agentPath}`,
            name: item.filename ?? item.body,
          })
          pathLines.push(`Attached file: ${paths.agentPath}`)
        }
      } else {
        // File route (m.file, m.video, m.audio, or oversized image)
        if (!opts.agent.workspaceDir) continue
        const { data } = await opts.media.download({
          mxcUri: item.url,
          asUserId: opts.agent.userId,
        })
        const paths = opts.writeAttachmentFn({
          workspaceDir: opts.agent.workspaceDir,
          agentWorkspacePath: opts.agent.agentWorkspacePath ?? opts.agent.workspaceDir,
          eventId: item.eventId,
          filename: item.filename ?? item.body,
          data,
        })
        blocks.push({
          type: 'resource_link',
          uri: `file://${paths.agentPath}`,
          name: item.filename ?? item.body,
          mimeType: item.info?.mimetype,
          size: item.info?.size,
        })
        pathLines.push(`Attached file: ${paths.agentPath}`)
      }
    } catch (err) {
      opts.onError(item, err)
    }
  }

  return { blocks, pathLines }
}

/**
 * Emit the stock-client mirror for an activity event, if it has one. Returns
 * the notice's event id (for approval correlation) or undefined. Best-effort:
 * a failed mirror never breaks the custom-event path.
 */
async function sendMirrorNotice(
  client: MatrixClient,
  input: {
    roomId: string
    asUserId: string
    threadRoot: string
    eventType: string
    content: Record<string, unknown>
  },
): Promise<string | undefined> {
  const body = toActivityNoticeBody(input.eventType, input.content)
  if (!body) return undefined
  try {
    const { event_id } = await client.sendMessage({
      roomId: input.roomId,
      asUserId: input.asUserId,
      threadRoot: input.threadRoot,
      content: { msgtype: 'm.notice', body },
    })
    return event_id
  } catch (err) {
    console.warn(`[matrix] mirror notice for ${input.eventType} failed:`, err)
    return undefined
  }
}

async function sendMediaError(
  ctx: { agent: AgentBinding; roomId: string; threadRoot: string },
  _err: unknown,
  message: string,
  client: MatrixClient,
): Promise<void> {
  const content = toErrorBody(
    {
      kind: 'error' as const,
      agentId: ctx.agent.name,
      sessionId: null,
      turnId: null,
      code: 'media_failed',
      message: message.slice(0, 250),
      transient: false,
    },
    ctx.threadRoot,
  )
  await client
    .sendCustomEvent({
      roomId: ctx.roomId,
      asUserId: ctx.agent.userId,
      eventType: 'dev.zooid.error',
      content,
    })
    .catch((e) => console.warn(`[matrix:${ctx.agent.name}] dev.zooid.error send failed:`, e))
  void sendMirrorNotice(client, {
    roomId: ctx.roomId,
    asUserId: ctx.agent.userId,
    threadRoot: ctx.threadRoot,
    eventType: 'dev.zooid.error',
    content,
  })
}
const SEEN_EVENT_CAP = 5_000

// ACP only guarantees that an agent flushes pending `session/update`
// notifications before the `session/prompt` response in the *cancellation*
// path; for a normal turn the ordering is unspecified. Some agents (e.g.
// opencode) emit trailing `agent_message_chunk`s a few ms after the stopReason
// response, so finalizing the moment `prompt()` resolves truncates the reply.
// After the turn resolves we wait for the buffer to stay unchanged for
// DRAIN_QUIET_MS (debounce — re-arms on each late chunk) before flushing,
// capped at DRAIN_MAX_MS so a misbehaving stream can't hang the turn.
const DRAIN_QUIET_MS = 300
// 30s upper bound on how long we wait after `session/prompt` resolves before
// flushing whatever we have (or declaring an empty turn). Set high because
// some agents — opencode especially — resolve the prompt promise *before*
// the agent_message_chunk stream starts, and the chunk burst can be 5–15s
// after that. The drain still short-circuits via DRAIN_QUIET_MS once any
// content has settled, so this cap only kicks in for genuinely-stuck turns.
const DRAIN_MAX_MS = 30_000

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function inboundThreadRoot(evt: MatrixEvent): string | undefined {
  const r = evt.content?.['m.relates_to']
  return r?.rel_type === 'm.thread' && r.event_id ? r.event_id : undefined
}

export function createMatrixTransport(opts: CreateMatrixTransportOptions) {
  const {
    agents,
    approvals,
    client,
    bindings,
    hsToken,
    adminUserId,
    botUserId,
    mode = 'appservice',
  } = opts
  const drainQuietMs = opts.drainQuietMs ?? DRAIN_QUIET_MS
  const drainMaxMs = opts.drainMaxMs ?? DRAIN_MAX_MS
  const returnGraceMs = opts.returnGraceMs ?? RETURN_GRACE_MS
  const mediaClient = opts.media
  const writeAttachmentFn = opts.writeAttachmentFn ?? writeAttachment
  const pendingMedia = new PendingMediaStore()
  const pool = new BotPool(client, bindings)
  const ourBotUserIds = new Set<string>([
    ...(botUserId ? [botUserId] : []),
    ...bindings.map((b) => b.userId),
  ])
  const DECLINE_REASON =
    'Bots are placed in rooms only by the zooid daemon (workforce-as-code). ' +
    'Ad-hoc invites are declined — add the bot to the room in zooid.yaml.'
  const sessions = new Map<string, SessionContext>()
  const buffers = new Map<string, string>()
  // Last messageId seen per session's buffer. opencode streams each assistant
  // message under its own id with no delimiter chunk between them, so a change
  // here marks a message boundary we must break on.
  const bufferMessageIds = new Map<string, string>()
  // Per-session promise tail so out-of-band events (tool_call, plan, etc.)
  // serialize on the wire even though the ACP producer doesn't await us.
  const sendQueue = new Map<string, Promise<void>>()
  // Thread participation index: keyed by thread root event_id.
  const threadStates = new Map<string, ThreadState>()
  const taskRegistry = new TaskRegistry({ journal: opts.taskJournal, runId: opts.taskRunId })
  const interruptedTasks = taskRegistry.restore()
  const invocations = new InvocationRegistry()
  const pendingInput = opts.pendingInput ?? NO_PENDING_INPUT
  const bindingFor = (name: string) => bindings.find((b) => b.name === name)
  const turnQueues = new Map<string, Promise<void>>()
  /**
   * Returns awaiting their sender's turn boundary, keyed `<agent>::<threadRoot>`.
   * See `isReturnRoute`: an agent turn posts one message per buffered chunk, so
   * a return must not fire per message or the caller wakes once per chunk (and
   * its replies then read as the two agents re-triggering each other). We stash
   * the callee's prose instead and hand the caller the whole turn at once.
   */
  const pendingReturns = new Map<string, PendingReturn>()
  const returnKey = (agentName: string, threadRoot: string) => `${agentName}::${threadRoot}`

  // ── Element-compatible mirror + interactive approvals ───────────────────
  // Correlation for approvals answered from a stock Matrix client instead of a
  // `dev.zooid.approval_response` custom event. `approvalByEvent` maps the
  // event ids of the approval's custom event and its mirrored notice back to
  // the approval; `approvalMeta` maps the approval to where it lives so a
  // command can be scope-checked to the right room/thread and a confirmation
  // posted in the right place.
  interface ApprovalMeta {
    roomId: string
    threadRoot: string
    asUserId: string
  }
  const approvalByEvent = new Map<string, string>()
  const approvalMeta = new Map<string, ApprovalMeta>()

  function forgetApproval(approvalId: string): void {
    approvalMeta.delete(approvalId)
    for (const [eventId, id] of approvalByEvent) {
      if (id === approvalId) approvalByEvent.delete(eventId)
    }
  }

  /**
   * Send an outbound `dev.zooid.*` activity event and, when it has a mirror
   * (see `toActivityNoticeBody`), a threaded `m.notice` so stock Element
   * clients show it. The custom event is always sent — the Zooid client needs
   * it. Returns both event ids.
   */
  async function sendActivity(input: {
    roomId: string
    asUserId: string
    eventType: string
    content: Record<string, unknown>
    threadRoot: string
  }): Promise<{ event_id: string; noticeEventId?: string }> {
    const { event_id } = await client.sendCustomEvent({
      roomId: input.roomId,
      asUserId: input.asUserId,
      eventType: input.eventType,
      content: input.content,
    })
    const noticeEventId = await sendMirrorNotice(client, input)
    return { event_id, noticeEventId }
  }

  // ── Per-turn editable mirror line (v3: collapsible details) ─────────────
  // Instead of one `m.notice` per `dev.zooid.*` event (which spammed the
  // timeline), a turn gets ONE threaded notice, edited in place with `m.replace`
  // as tools run and finalized on turn end. v3 renders it as a collapsed
  // `<details>` block: `<summary>` is the last activity (`🔧 dev: bash —
  // running`), and the body is an append-only list with one compact line per
  // tool (`✓ bash — done`). A new `tool_call_id` appends an entry; a later
  // `tool_call_update` for the same id mutates that entry in place, never a
  // duplicate. On turn end the summary is finalized to
  // `✅ dev: done · N tools · M files` (`⚠️ … failed`).
  // `tool_call`, `tool_call_update`, `plan` and `available_commands_update` are
  // folded into it — but tool activity and a plan update create the line;
  // `available_commands_update` only updates one that already exists, so a
  // prose-only turn (whose session replayed its command roster) gets no line.
  // The raw custom events still go out (visible via Element's "show hidden
  // events"). `approval_request` and `error` stay standalone because they must
  // be actionable. The line is marked (see `TURN_MIRROR_MARKER`) so the Zooid
  // web client can hide it.
  interface TurnMirrorState {
    /** Event id of the editable notice; '' until it is created. */
    eventId: string
    /** Last plain-text summary applied — used to skip no-op (idempotent) edits. */
    lastBody: string
    /** Last formatted_body applied — the details list changes even when the
     * summary text does not, so both must match to skip an edit. */
    lastHtml: string
    /** Ordered tool entries (append-only, first-seen); keyed by `tool_call_id`. */
    tools: TurnToolEntry[]
    /** `tool_call_id` → index in `tools`, for in-place updates. */
    toolIndex: Map<string, number>
    /** Summary detail of the most recent activity (tool title / plan / commands). */
    detail: string
    /** Distinct file paths touched this turn (from tool locations). */
    files: Set<string>
    finalized: boolean
  }
  const turnMirrors = new Map<string, TurnMirrorState>()

  function nonEmptyString(v: unknown): string | undefined {
    return typeof v === 'string' && v.length > 0 ? v : undefined
  }

  function isMissingEventError(err: unknown): boolean {
    // The status is authoritative. The fallback must stay narrow: the thrown
    // message carries the homeserver body, so a broad `/not found/` would
    // misread a `403 Room not found` as a redacted original and recreate the
    // line. Only the Matrix not-found errcode / event wording counts.
    if ((err as { status?: number } | null)?.status === 404) return true
    const msg = err instanceof Error ? err.message : String(err)
    return /M_NOT_FOUND|unknown event|event not found/i.test(msg)
  }

  async function createTurnMirror(
    ctx: SessionContext,
    summary: string,
    formattedBody: string,
  ): Promise<string | undefined> {
    try {
      const { event_id } = await client.sendMessage({
        roomId: ctx.roomId,
        asUserId: ctx.agent.userId,
        threadRoot: ctx.threadRoot,
        content: turnMirrorNoticeContent(summary, formattedBody, ctx.threadRoot),
      })
      return event_id
    } catch (err) {
      console.warn('[matrix] turn mirror create failed:', err)
      return undefined
    }
  }

  async function editTurnMirror(
    ctx: SessionContext,
    state: TurnMirrorState,
    summary: string,
    formattedBody: string,
  ): Promise<void> {
    try {
      await client.sendMessage({
        roomId: ctx.roomId,
        asUserId: ctx.agent.userId,
        content: turnMirrorEditContent(state.eventId, summary, formattedBody, ctx.threadRoot),
      })
      state.lastBody = summary
      state.lastHtml = formattedBody
    } catch (err) {
      if (isMissingEventError(err)) {
        // The original was redacted or otherwise gone — recreate so the summary
        // is not silently lost, and retarget later edits at the new event.
        const eventId = await createTurnMirror(ctx, summary, formattedBody)
        if (eventId) {
          state.eventId = eventId
          state.lastBody = summary
          state.lastHtml = formattedBody
        }
        return
      }
      // Best-effort: a failed edit never breaks the custom-event path.
      console.warn('[matrix] turn mirror edit failed:', err)
    }
  }

  /**
   * Append a new tool entry, or update the existing one for this `tool_call_id`
   * in place. A `tool_call` and a `tool_call_update` for the same id therefore
   * share one entry (and one line) — updates never append a duplicate.
   */
  function upsertToolEntry(
    state: TurnMirrorState,
    content: Record<string, unknown>,
  ): TurnToolEntry | undefined {
    const toolCallId = nonEmptyString(content.tool_call_id)
    if (!toolCallId) return undefined
    const existing = state.toolIndex.get(toolCallId)
    let entry: TurnToolEntry
    if (existing === undefined) {
      entry = {
        toolCallId,
        title: nonEmptyString(content.title) ?? toolCallId,
        status: nonEmptyString(content.status),
      }
      state.toolIndex.set(toolCallId, state.tools.length)
      state.tools.push(entry)
    } else {
      entry = state.tools[existing]!
      const title = nonEmptyString(content.title)
      if (title) entry.title = title
      const status = nonEmptyString(content.status)
      if (status) entry.status = status
    }
    return entry
  }

  async function updateTurnMirror(
    sessionId: string,
    ctx: SessionContext,
    input: { eventType: string; content: Record<string, unknown> },
  ): Promise<void> {
    let state = turnMirrors.get(sessionId)
    if (state?.finalized) return
    // Only tool activity and a plan may create the line (see `createsTurnLine`);
    // `available_commands_update` updates an existing line only.
    if (!state && !createsTurnLine(input.eventType)) return
    if (!state) {
      state = {
        eventId: '',
        lastBody: '',
        lastHtml: '',
        tools: [],
        toolIndex: new Map(),
        detail: 'working…',
        files: new Set(),
        finalized: false,
      }
      turnMirrors.set(sessionId, state)
    }
    const { eventType, content } = input
    if (eventType === 'dev.zooid.tool_call' || eventType === 'dev.zooid.tool_call_update') {
      const entry = upsertToolEntry(state, content)
      if (entry) state.detail = toolSummaryDetail(entry)
    } else {
      const detail = activityDetail(eventType, content)
      if (detail) state.detail = detail
    }
    const locations = content.locations
    if (Array.isArray(locations)) {
      for (const loc of locations) {
        const path = (loc as { path?: unknown } | null)?.path
        if (typeof path === 'string') state.files.add(path)
      }
    }
    const summary = turnWorkingBody(ctx.agent.name, state.detail)
    const html = renderTurnDetails(summary, state.tools)
    if (!state.eventId) {
      // Only tool activity / a plan ever reaches here with no line yet (see the
      // `createsTurnLine` guard above); `available_commands_update` is filtered
      // again so a line whose creation failed is not retried from an
      // informational event.
      if (!createsTurnLine(eventType)) return
      const eventId = await createTurnMirror(ctx, summary, html)
      if (eventId) {
        state.eventId = eventId
        state.lastBody = summary
        state.lastHtml = html
      }
      return
    }
    if (summary === state.lastBody && html === state.lastHtml) return
    await editTurnMirror(ctx, state, summary, html)
  }

  async function finalizeTurnMirror(
    sessionId: string,
    ctx: SessionContext,
    failed: boolean,
  ): Promise<void> {
    const state = turnMirrors.get(sessionId)
    if (!state || state.finalized) return
    state.finalized = true
    if (!state.eventId) {
      turnMirrors.delete(sessionId)
      return
    }
    const summary = turnFinalBody(
      ctx.agent.name,
      { toolCount: state.tools.length, fileCount: state.files.size },
      failed,
    )
    const html = renderTurnDetails(summary, state.tools)
    if (summary !== state.lastBody || html !== state.lastHtml) {
      await editTurnMirror(ctx, state, summary, html)
    }
    turnMirrors.delete(sessionId)
  }

  function firstAgentUserIdForRoom(roomId: string): string | undefined {
    return bindings.find((b) => b.rooms.some((r) => r.alias === roomId))?.userId
  }

  async function postApprovalNotice(
    roomId: string | undefined,
    threadRoot: string | undefined,
    asUserId: string | undefined,
    body: string,
  ): Promise<void> {
    if (!roomId) return
    const sender = asUserId ?? firstAgentUserIdForRoom(roomId)
    if (!sender) return
    await client
      .sendMessage({
        roomId,
        asUserId: sender,
        ...(threadRoot ? { threadRoot } : {}),
        content: { msgtype: 'm.notice', body },
      })
      .catch((e) => console.warn('[matrix] approval notice send failed:', e))
  }

  /**
   * Resolve a pending approval from a command. The read of `get()` and the
   * `resolveById()` below happen in the same synchronous tick with no `await`
   * between them, and `resolveById` deletes the entry, so two commands for the
   * same approval cannot both win — the loser sees `already resolved`.
   */
  function resolveApprovalCommand(
    approvalId: string,
    command: ApprovalCommand,
  ): { resolved: boolean; reason?: string } {
    const approval = approvals.get(approvalId)
    if (!approval) return { resolved: false, reason: 'already resolved' }
    const mapped = decisionForCommand(command, approval.options)
    if (!mapped.ok) return { resolved: false, reason: mapped.reason }
    const ok = approvals.resolveById(approvalId, mapped.decision)
    return { resolved: ok, reason: ok ? undefined : 'already resolved' }
  }

  /**
   * Resolve a pending approval and post the outcome notice in its thread.
   * Shared by the reaction, explicit-id, and bare-command paths.
   */
  async function applyApprovalCommand(
    approvalId: string,
    command: ApprovalCommand,
    meta: ApprovalMeta,
  ): Promise<void> {
    const result = resolveApprovalCommand(approvalId, command)
    await postApprovalNotice(
      meta.roomId,
      meta.threadRoot,
      meta.asUserId,
      approvalOutcomeNotice(approvalId, command, result),
    )
  }

  function approvalOutcomeNotice(
    approvalId: string,
    command: ApprovalCommand,
    result: { resolved: boolean; reason?: string },
  ): string {
    if (result.resolved) return `✅ Approval ${command === 'approve' ? 'granted' : 'denied'}.`
    // A `decisionForCommand` failure leaves the approval pending — say so,
    // rather than claiming it was resolved.
    if (result.reason && result.reason !== 'already resolved') {
      return `Could not ${command} approval ${approvalId}: ${result.reason}.`
    }
    return `Approval ${approvalId} was already resolved.`
  }

  /** Returns true when the reaction was an approval decision we handled. */
  async function handleApprovalReaction(evt: MatrixEvent): Promise<boolean> {
    const rel = evt.content?.['m.relates_to'] as
      | { rel_type?: string; event_id?: string; key?: string }
      | undefined
    if (!rel || rel.rel_type !== 'm.annotation' || !rel.event_id) return false
    // The reaction key is top-level `key` per the m.reaction schema; some
    // clients duplicate it into the relation. Accept either.
    const command = reactionCommand(evt.content?.key ?? rel.key)
    if (!command) return false
    // Agents must not approve their own (or each other's) requests.
    if (evt.sender && ourBotUserIds.has(evt.sender)) return false
    const approvalId = approvalByEvent.get(rel.event_id)
    if (!approvalId) return false
    const meta = approvalMeta.get(approvalId)
    if (!meta || meta.roomId !== evt.room_id) return false
    await applyApprovalCommand(approvalId, command, meta)
    return true
  }

  async function maybeHandleApprovalMessage(evt: MatrixEvent): Promise<boolean> {
    const body = typeof evt.content?.body === 'string' ? evt.content.body : ''
    const parsed = parseApprovalCommand(body)
    if (!parsed) return false
    if (evt.sender && ourBotUserIds.has(evt.sender)) return false
    const threadRoot = inboundThreadRoot(evt)

    if (parsed.approvalId) {
      // Only an id-shaped token is treated as a command. Prose that merely
      // starts with the word ("approve please") routes normally instead of
      // being consumed.
      if (!isApprovalId(parsed.approvalId)) return false
      const meta = approvalMeta.get(parsed.approvalId)
      if (!meta) {
        await postApprovalNotice(
          evt.room_id,
          threadRoot,
          undefined,
          `No pending approval \`${parsed.approvalId}\`.`,
        )
        return true
      }
      if (meta.roomId !== evt.room_id || (threadRoot && meta.threadRoot !== threadRoot)) {
        await postApprovalNotice(
          evt.room_id,
          threadRoot,
          undefined,
          `Approval \`${parsed.approvalId}\` is not pending in this thread.`,
        )
        return true
      }
      await applyApprovalCommand(parsed.approvalId, parsed.command, meta)
      return true
    }

    // Bare `approve` / `deny`: only meaningful as a reply *inside* the
    // approval's own thread (approvals are always thread-scoped), and only when
    // exactly one is pending there. Outside a thread, or with zero pending, the
    // message is ordinary prose and routes normally; more than one → refuse
    // rather than guess.
    if (!threadRoot) return false
    const candidates = [...approvalMeta.entries()].filter(
      ([, m]) => m.roomId === evt.room_id && m.threadRoot === threadRoot,
    )
    if (candidates.length === 0) return false
    if (candidates.length > 1) {
      await postApprovalNotice(
        evt.room_id,
        threadRoot,
        undefined,
        `${candidates.length} approvals are pending here — include the id: ` +
          '`approve <id>` or `deny <id>`.',
      )
      return true
    }
    const [approvalId, meta] = candidates[0]
    await applyApprovalCommand(approvalId, parsed.command, meta)
    return true
  }

  function stashReturn(
    sender: AgentBinding,
    threadRoot: string,
    roomId: string,
    evt: MatrixEvent,
    targets: AgentBinding[],
  ): void {
    const key = returnKey(sender.name, threadRoot)
    let pending = pendingReturns.get(key)
    if (!pending) {
      pending = { roomId, threadRoot, event: evt, texts: [], targets: new Map() }
      pendingReturns.set(key, pending)
    }
    // Prompt the caller with the last event of the turn but the text of all of
    // it — mid-turn chunks carry content the caller would otherwise never see.
    pending.event = evt
    const body = evt.content?.body?.trim()
    if (body) pending.texts.push(body)
    for (const t of targets) pending.targets.set(t.name, t)
    if (pending.timer) clearTimeout(pending.timer)
    pending.timer = setTimeout(() => releaseReturn(key), returnGraceMs)
    pending.timer.unref?.()
    console.log(
      `[matrix] holding return ${sender.name} → ${[...pending.targets.keys()].join(',')} ` +
        `until turn end (thread=${threadRoot})`,
    )
  }

  function releaseReturn(key: string): void {
    const pending = pendingReturns.get(key)
    if (!pending) return
    pendingReturns.delete(key)
    if (pending.timer) clearTimeout(pending.timer)
    const promptText = pending.texts.join('\n\n')
    for (const target of pending.targets.values()) {
      console.log(`[matrix] → ${target.name} (${target.userId}) [return]`)
      void enqueueTurn(target, {
        roomId: pending.roomId,
        threadRoot: pending.threadRoot,
        sessionKey: sessionKeyFor(
          target.name,
          pending.threadRoot,
          threadStates.get(pending.threadRoot),
        ),
        event: pending.event,
        ...(promptText ? { promptText } : {}),
      })
    }
  }

  /** Cancel a held return because its target is being woken by this event anyway. */
  function dropPendingReturn(threadRoot: string, agentName: string): void {
    for (const [key, pending] of pendingReturns) {
      if (pending.threadRoot !== threadRoot) continue
      if (!pending.targets.delete(agentName)) continue
      if (pending.targets.size === 0) {
        if (pending.timer) clearTimeout(pending.timer)
        pendingReturns.delete(key)
      }
    }
  }

  function dropThreadReturns(threadRoot: string): void {
    for (const [key, pending] of pendingReturns) {
      if (pending.threadRoot !== threadRoot) continue
      if (pending.timer) clearTimeout(pending.timer)
      pendingReturns.delete(key)
    }
  }
  // Drop events older than this — in push (appservice) mode Tuwunel may replay
  // a backlog after the daemon was offline, and we don't want yesterday's
  // "@docs hi" to fire now. In pull (client) mode the persisted `since` cursor
  // is the authoritative replay boundary (process everything after it — that's
  // exactly the offline-resume feature), so the timestamp guard must NOT apply:
  // the missed-while-offline mention is older than startup by design.
  const cutoffTs = mode === 'client' ? Number.NEGATIVE_INFINITY : Date.now() - STARTUP_GRACE_MS
  // Idempotency: appservice transactions are retried on 4xx/5xx/timeout, and
  // the same event_id can arrive twice. Skip ones we've already taken.
  const seenEventIds = new Set<string>()
  // Messages flushed per session this turn. Lets the drain loop tell "stream
  // not started yet" (0 flushes, empty buffer → keep waiting) from "turn done,
  // last message already flushed mid-stream" (>0 flushes, empty buffer → stop).
  const flushedCounts = new Map<string, number>()
  // Commands a shim advertises during session load/new — i.e. before runTurn
  // registers the session ctx (sessions.set). Stashed here keyed by sessionId
  // and replayed once the ctx exists, so `available_commands_update` (which is
  // only ever emitted at session establishment, never mid-turn) isn't dropped.
  const pendingCommands = new Map<string, AgentEvent>()

  // Build the m.text content for a chunk of assistant prose, attaching a
  // formatted_body only when the HTML render adds rich text the plain body
  // can't carry (marked wraps plain prose in <p>…</p>; skip that — most
  // clients render `body` better than a stripped re-encode).
  const buildTextContent = (
    text: string,
  ): { msgtype: string; body: string; [k: string]: unknown } => {
    const content: { msgtype: string; body: string; [k: string]: unknown } = {
      // m.notice, not m.text: .m.rule.suppress_notices silences the
      // chunk-storm of agent prose server-side (ZNC025 §10) instead of every
      // client having to filter it. dev.zooid.error carries the same tweak
      // for the same reason.
      msgtype: 'm.notice',
      body: text,
    }
    const html = toMatrixHtml(text)
    if (html) {
      const escapedPlain =
        '<p>' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>'
      const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
      if (norm(html) !== norm(escapedPlain)) {
        content.format = 'org.matrix.custom.html'
        content.formatted_body = html
      }
    }
    return content
  }

  // Flush a session's buffered assistant text as its own Matrix message and
  // clear the buffer. No-op on an empty buffer. The send is chained onto
  // sendQueue so it orders correctly against tool_call/plan events from the
  // same turn. The buffer is cleared synchronously (before the first await),
  // so a chunk for the *next* message that arrives during the send starts
  // fresh. Returns true when a message was enqueued.
  const lastFlushed = new Map<string, string>()

  const flushBuffer = (sessionId: string): boolean => {
    const ctx = sessions.get(sessionId)
    const text = buffers.get(sessionId) ?? ''
    if (!ctx || text.length === 0) return false
    buffers.set(sessionId, '')
    // Kept for turn.end's push preview: the prose goes out as `m.notice` and
    // is deliberately silenced server-side, so turn.end is the only event that
    // can tell the user what the agent actually said.
    lastFlushed.set(sessionId, text)
    flushedCounts.set(sessionId, (flushedCounts.get(sessionId) ?? 0) + 1)
    const content = buildTextContent(text)
    const pendingInvocations = registerOutgoingHandoffs(sessionId, text)
    const tail = (sendQueue.get(sessionId) ?? Promise.resolve()).then(async () => {
      try {
        const { event_id } = await client.sendMessage({
          roomId: ctx.roomId,
          asUserId: ctx.agent.userId,
          content,
          threadRoot: ctx.threadRoot,
        })
        for (const invocation of pendingInvocations)
          invocations.attachCallEvent(
            invocation.invocationId,
            event_id,
            composeHandoffKey(ctx.threadRoot, event_id),
          )
      } catch (err) {
        console.warn(`[matrix:${ctx.agent.name}] sendMessage flush failed:`, err)
      }
    })
    sendQueue.set(sessionId, tail)
    return true
  }

  function registerOutgoingHandoffs(sessionId: string, text: string) {
    const ctx = sessions.get(sessionId)
    if (!ctx) return []
    const task = taskRegistry.taskForRoot(ctx.threadRoot)
    if (!task || task.phase !== 'open') return []
    const sessionKey = sessionKeyFor(ctx.agent.name, ctx.threadRoot, threadStates.get(ctx.threadRoot))
    const opened = []
    for (const userId of extractMentions({ content: { body: text } })) {
      const callee = bindings.find((binding) => binding.userId === userId)
      if (!callee || callee.name === ctx.agent.name) continue
      if (invocations.isOutstandingAncestor(sessionKey, callee.name)) {
        const content = { body: `⚠ [handoff_circular] Cannot hand off to ${callee.name}: it is waiting on ${ctx.agent.name}`, code: 'handoff_circular', message: `Cannot hand off to ${callee.name}: it is waiting on ${ctx.agent.name}`, transient: false, 'm.relates_to': { rel_type: 'm.thread', event_id: ctx.threadRoot } }
        void client.sendCustomEvent({
          roomId: ctx.roomId, asUserId: ctx.agent.userId, eventType: 'dev.zooid.error', content,
        })
        void sendMirrorNotice(client, {
          roomId: ctx.roomId, asUserId: ctx.agent.userId, threadRoot: ctx.threadRoot,
          eventType: 'dev.zooid.error', content,
        })
        continue
      }
      opened.push(invocations.open({ taskId: task.taskId, callerAgent: ctx.agent.name, callerSessionKey: sessionKey, calleeAgent: callee.name }))
      taskRegistry.clearSummary(task.taskId)
    }
    return opened
  }

  agents.onEvent = async (name, event: AgentEvent) => {
    const ctx = sessions.get(event.sessionId)
    if (!ctx) {
      // available_commands_update is advertised during ensureSession (session
      // load/new), before runTurn calls sessions.set — so the ctx isn't there
      // yet. Stash the latest roster and replay it once runTurn registers the
      // ctx. Other event types arriving without a ctx are genuinely orphaned
      // (e.g. replayed history for a thread we're not handling) — drop them.
      if (event.type === 'available_commands') {
        pendingCommands.set(event.sessionId, event)
      } else {
        console.warn(`[matrix:${name}] no session ctx for ${event.sessionId}`)
      }
      return
    }

    if (event.type === 'agent_message_chunk') {
      const block = event.content as {
        type?: string
        text?: string
        data?: string
        mimeType?: string
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        // A change in ACP messageId marks the previous assistant message as
        // complete. opencode streams each assistant message under its own id
        // with no delimiter chunk between them, so a change here is the only
        // boundary signal. Flush the previous message as its own Matrix
        // message — each ACP message lands separately (and interleaves with
        // tool_call/plan events) instead of welding into one turn-end blob.
        const prevMessageId = bufferMessageIds.get(event.sessionId)
        const messageChanged =
          event.messageId !== undefined &&
          prevMessageId !== undefined &&
          event.messageId !== prevMessageId
        if (event.messageId !== undefined) bufferMessageIds.set(event.sessionId, event.messageId)
        // flushBuffer clears the buffer synchronously, so the new message's
        // text below starts fresh.
        if (messageChanged) flushBuffer(event.sessionId)
        // Within a single message, tokens carry their own leading spaces, so we
        // concatenate raw. An empty chunk (some agents emit one between blocks,
        // e.g. after a tool call within the same message) is a paragraph break.
        const current = buffers.get(event.sessionId) ?? ''
        const needsBreak = current.length > 0 && block.text === ''
        const prefix = needsBreak ? '\n\n' : ''
        buffers.set(event.sessionId, current + prefix + block.text)
      } else if (
        block.type === 'image' &&
        typeof block.data === 'string' &&
        typeof block.mimeType === 'string' &&
        mediaClient
      ) {
        // Outbound agent image: upload immediately and send as a threaded m.image.
        const ctx = sessions.get(event.sessionId)
        if (ctx) {
          const bytes = Buffer.from(block.data, 'base64')
          const ext = (block.mimeType.split('/')[1] ?? 'png').replace(/[^a-z0-9]/gi, '')
          const filename = `image.${ext}`
          void mediaClient
            .upload({
              data: bytes,
              contentType: block.mimeType,
              filename,
              asUserId: ctx.agent.userId,
            })
            .then(({ content_uri }) =>
              client.sendMessage({
                roomId: ctx.roomId,
                asUserId: ctx.agent.userId,
                threadRoot: ctx.threadRoot,
                content: {
                  msgtype: 'm.image',
                  body: filename,
                  url: content_uri,
                  info: { mimetype: block.mimeType, size: bytes.length },
                },
              }),
            )
            .catch((err) => {
              console.warn(`[matrix:${name}] outbound image upload failed:`, err)
              void sendMediaError(ctx, err, 'agent image upload failed', client)
            })
        }
      } else {
        console.warn(`[matrix:${name}] dropped chunk block type=${block.type}`, block)
      }
      return
    }

    // An out-of-band event (tool_call / tool_call_update / plan) after some
    // buffered text means that assistant message is complete — flush it first
    // so it lands before this event on the wire, preserving interleaving.
    flushBuffer(event.sessionId)

    const eventType =
      event.type === 'tool_call'
        ? 'dev.zooid.tool_call'
        : event.type === 'tool_call_update'
          ? 'dev.zooid.tool_call_update'
          : event.type === 'available_commands'
            ? 'dev.zooid.available_commands_update'
            : 'dev.zooid.plan'
    const body =
      event.type === 'tool_call'
        ? toToolCallBody(event)
        : event.type === 'tool_call_update'
          ? toUpdateBody(event)
          : event.type === 'available_commands'
            ? toAvailableCommandsBody(event)
            : toPlanBody(event)
    body['m.relates_to'] = { rel_type: 'm.thread', event_id: ctx.threadRoot }
    const tail = (sendQueue.get(event.sessionId) ?? Promise.resolve()).then(async () => {
      try {
        await client.sendCustomEvent({
          roomId: ctx.roomId,
          asUserId: ctx.agent.userId,
          eventType,
          content: body,
        })
      } catch (err) {
        console.warn(`[matrix:${name}] sendCustomEvent(${eventType}) failed:`, err)
      }
      // Folded into the single per-turn mirror line rather than mirrored
      // individually. Best-effort: never affects the custom-event path.
      await updateTurnMirror(event.sessionId, ctx, { eventType, content: body })
    })
    sendQueue.set(event.sessionId, tail)
    await tail
  }

  agents.onApprovalRequest = async (name, req) => {
    const handle = approvals.register(name, (req as { sessionId: string }).sessionId, req, {
      timeoutMs: agents.getApprovalTimeoutMs(name),
    })
    return handle.decisionPromise
  }

  approvals.on('registered', (handle: RegisteredApproval) => {
    const ctx = sessions.get(handle.sessionId)
    if (!ctx) return
    const content: Record<string, unknown> = {
      approval_id: handle.approvalId,
      session_id: handle.sessionId,
      tool_call_id: handle.toolCallId,
      options: handle.options,
    }
    content['m.relates_to'] = {
      rel_type: 'm.thread',
      event_id: ctx.threadRoot,
    }
    if (handle.toolKind !== undefined) content.tool_kind = handle.toolKind
    if (handle.toolTitle !== undefined) content.tool_title = handle.toolTitle
    if (handle.toolInput !== undefined) content.tool_input = handle.toolInput
    approvalMeta.set(handle.approvalId, {
      roomId: ctx.roomId,
      threadRoot: ctx.threadRoot,
      asUserId: ctx.agent.userId,
    })
    void (async () => {
      try {
        const { event_id, noticeEventId } = await sendActivity({
          roomId: ctx.roomId,
          asUserId: ctx.agent.userId,
          eventType: 'dev.zooid.approval_request',
          content,
          threadRoot: ctx.threadRoot,
        })
        // Both the custom event and its mirror are valid reaction targets.
        approvalByEvent.set(event_id, handle.approvalId)
        if (noticeEventId) approvalByEvent.set(noticeEventId, handle.approvalId)
      } catch (err) {
        console.warn(`[matrix] approval_request send failed:`, err)
      }
    })()
  })

  // Drop correlation state as soon as an approval leaves the pending map, so a
  // late reaction cannot resolve a different approval and the maps don't grow.
  approvals.on('resolved', ({ approvalId }: { approvalId: string }) => forgetApproval(approvalId))
  approvals.on('timeout', ({ approvalId }: { approvalId: string }) => forgetApproval(approvalId))

  function reportTurnFailure(agent: AgentBinding, input: TurnInput, err: unknown): void {
    console.error(`[matrix] runTurn failed for ${agent.name}:`, err)
    const c = classify(err)
    const body = toErrorBody(
      {
        kind: 'error',
        agentId: agent.name,
        sessionId: null,
        turnId: null,
        code: c.code,
        message: err instanceof Error ? err.message : String(err),
        detail: err instanceof Error && err.stack ? err.stack.slice(0, 2000) : undefined,
        transient: c.transient,
        acp_error: c.acp_error,
      },
      input.threadRoot,
    )
    void client
      .sendCustomEvent({
        roomId: input.roomId,
        asUserId: agent.userId,
        eventType: 'dev.zooid.error',
        content: body,
      })
      .catch((e) => console.warn(`[matrix:${agent.name}] dev.zooid.error send failed:`, e))
    void sendMirrorNotice(client, {
      roomId: input.roomId,
      asUserId: agent.userId,
      threadRoot: input.threadRoot,
      eventType: 'dev.zooid.error',
      content: body,
    })
  }

  function enqueueTurn(agent: AgentBinding, input: TurnInput): Promise<void> {
    const key = `${agent.name}::${input.sessionKey}`
    const chained = (turnQueues.get(key) ?? Promise.resolve())
      .then(() => runTurn(agent, input))
      .then(() => {
        let st = threadStates.get(input.threadRoot)
        if (!st) {
          st = {
            participants: [],
            rootMentions: [],
            callers: {},
            handoffs: {},
          }
          threadStates.set(input.threadRoot, st)
        }
        if (st.participants.at(-1) !== agent.name) st.participants.push(agent.name)
      })
      .catch((err) => reportTurnFailure(agent, input, err))
    turnQueues.set(key, chained)
    void chained.finally(() => {
      if (turnQueues.get(key) === chained) turnQueues.delete(key)
    })
    return chained
  }

  async function handleInboundEvent(evt: MatrixEvent): Promise<void> {
    if (evt.event_id) {
      if (seenEventIds.has(evt.event_id)) {
        return
      }
      seenEventIds.add(evt.event_id)
      if (seenEventIds.size > SEEN_EVENT_CAP) {
        const first = seenEventIds.values().next().value
        if (first !== undefined) seenEventIds.delete(first)
      }
    }
    if (
      evt.origin_server_ts !== undefined &&
      evt.origin_server_ts < cutoffTs &&
      evt.type === 'm.room.message'
    ) {
      console.log(
        `[matrix] dropping stale message event ${evt.event_id} ` +
          `(ts=${evt.origin_server_ts}, daemon started at ${cutoffTs + STARTUP_GRACE_MS})`,
      )
      return
    }
    if (evt.type === 'm.room.member' && evt.content?.membership === 'invite') {
      const target = evt.state_key
      const inviter = evt.sender
      if (
        target &&
        evt.room_id &&
        ourBotUserIds.has(target) &&
        (!inviter || !ourBotUserIds.has(inviter))
      ) {
        console.log(
          `[matrix] declining ad-hoc invite for ${target} in ${evt.room_id} ` +
            `from ${inviter ?? 'unknown'}`,
        )
        await client
          .leaveRoom(evt.room_id, target, { reason: DECLINE_REASON })
          .catch((err) =>
            console.warn(`[matrix] leaveRoom(${evt.room_id}, ${target}) failed:`, err),
          )
      }
      return
    }
    if (evt.type === 'dev.zooid.session_reset') {
      // Spec § /clear: room-scope reset is unsupported. Only thread-scoped
      // resets carry a thread relation; drop bare room-level resets silently.
      const relates = evt.content?.['m.relates_to'] as
        | { rel_type?: string; event_id?: string }
        | undefined
      const threadRoot =
        relates?.rel_type === 'm.thread' && relates.event_id ? relates.event_id : undefined
      if (!threadRoot) {
        console.log('[matrix] dropping dev.zooid.session_reset without thread relation')
        return
      }
      console.log(`[matrix] inbound dev.zooid.session_reset in ${evt.room_id} thread=${threadRoot}`)
      // /clear must not allow a pre-reset deferred return to wake an agent up
      // later via either its old turn.end or the fallback timer.
      dropThreadReturns(threadRoot)
      // [[ZOD071]]: a thread's sessions are the thread-level one plus one per
      // handoff arc — end them all. Reset events aren't m.room.message, so
      // the self-heal rebuild above doesn't cover them; rebuild here if the
      // daemon restarted since the arcs were minted.
      if (!threadStates.has(threadRoot) && evt.room_id) {
        try {
          threadStates.set(
            threadRoot,
            await rebuildThreadState(client, evt.room_id, threadRoot, bindings),
          )
        } catch (err) {
          console.warn(`[matrix] failed to rebuild threadState for reset ${threadRoot}:`, err)
        }
      }
      const st = threadStates.get(threadRoot)
      for (const a of bindings) {
        agents.endSession(a.name, threadRoot)
        taskRegistry.bumpGeneration(a.name, threadRoot)
        for (const arc of st?.handoffs[a.name] ?? []) {
          const key = composeHandoffKey(threadRoot, arc)
          agents.endSession(a.name, key)
          taskRegistry.bumpGeneration(a.name, key)
        }
      }
      // NB: keep threadStates intact. Per ZOD039 § /clear, only the agent's
      // session memory is wiped — thread-routing state (participants /
      // root-mentions) must survive so the next bare reply still routes to
      // the most-recently-posting agent under the same sessionKey.
      return
    }
    if (evt.type === 'dev.zooid.interrupt') {
      const content = (evt.content ?? {}) as {
        session_id?: string
        reason?: string
      }
      // Thread-relation form (client-friendly): /interrupt in a thread sends
      // an empty event with `m.relates_to: thread/<root>`. Cancel every
      // session whose threadRoot matches.
      const relates = evt.content?.['m.relates_to'] as
        | { rel_type?: string; event_id?: string }
        | undefined
      const threadRoot =
        relates?.rel_type === 'm.thread' && relates.event_id ? relates.event_id : undefined
      if (threadRoot) {
        const targets: Array<{ sessionId: string; agent: string }> = []
        for (const [sessionId, ctx] of sessions) {
          if (ctx.threadRoot === threadRoot) {
            targets.push({ sessionId, agent: ctx.agent.name })
          }
        }
        for (const t of targets) {
          console.log(
            `[matrix] interrupt session=${t.sessionId} agent=${t.agent} thread=${threadRoot}` +
              (content.reason ? ` reason=${content.reason}` : ''),
          )
          await agents.cancelSession(t.agent, t.sessionId).catch((err) => {
            console.error(`[matrix] cancelSession(${t.agent}, ${t.sessionId}) failed:`, err)
          })
        }
        // A live session will report ACP's `cancelled` stop reason and finish
        // in its turn boundary, preserving any prose it already emitted. A
        // restored/no-session task has no such boundary, so close it here.
        const task = taskRegistry.taskForRoot(threadRoot)
        if (task?.phase === 'open' && !targets.some((t) => t.agent === task.assignee)) {
          const assignee = bindingFor(task.assignee)
          if (assignee)
            await finishTask(task, {
              agent: assignee,
              completion: { agent: assignee.name, thread_id: threadRoot, status: 'cancelled' },
            })
        }
        return
      }
      // Legacy form: explicit session_id in content.
      if (!content.session_id) {
        console.warn(`[matrix] dev.zooid.interrupt missing session_id (event_id=${evt.event_id})`)
        return
      }
      const ctx = sessions.get(content.session_id)
      if (!ctx) {
        return
      }
      console.log(
        `[matrix] interrupt session=${content.session_id} agent=${ctx.agent.name}` +
          (content.reason ? ` reason=${content.reason}` : ''),
      )
      await agents.cancelSession(ctx.agent.name, content.session_id).catch((err) => {
        console.error(
          `[matrix] cancelSession(${ctx.agent.name}, ${content.session_id}) failed:`,
          err,
        )
      })
      return
    }
    if (evt.type === 'dev.zooid.approval_response') {
      // Agents never legitimately answer their own permission request — only a
      // human (via the Zooid client) does. Ignore a bot sender so an agent
      // cannot self-approve through this legacy path either.
      if (evt.sender && ourBotUserIds.has(evt.sender)) return
      const content = (evt.content ?? {}) as {
        approval_id?: string
        session_id?: string
        decision?: string
        option_id?: string
      }
      if (!content.session_id || !content.approval_id || !content.decision) return
      const decision = content.option_id
        ? { decision: content.decision, optionId: content.option_id }
        : { decision: content.decision }
      const ok = approvals.resolve(content.session_id, content.approval_id, decision as never)
      if (!ok) console.warn(`[matrix] unknown approval ${content.approval_id}`)
      return
    }

    // Interactive approvals from a stock client: a ✅/❌ reaction on the
    // approval message, or a plain `approve <id>` / `deny <id>` message. These
    // never reach the router — an approval command is not a prompt.
    if (evt.type === 'm.reaction' && (await handleApprovalReaction(evt))) {
      return
    }
    if (evt.type === 'm.room.message' && (await maybeHandleApprovalMessage(evt))) {
      return
    }
    logInbound(evt)

    // The callee's turn boundary: the daemon sends this only after that turn's
    // whole send queue has drained, so every message it produced has already
    // arrived above. Release the return it was holding.
    if (evt.type === 'dev.zooid.turn.end') {
      const agentId = evt.content?.agent_id as string | undefined
      const endedRoot = inboundThreadRoot(evt)
      const senderAgent = bindings.find((binding) => binding.userId === evt.sender)
      // Bind the claimed agent_id to the Matrix sender. Besides rejecting a
      // malformed boundary, this prevents another room member from releasing
      // a held agent return early by forging custom-event content.
      if (agentId && endedRoot && senderAgent?.name === agentId) {
        releaseReturn(returnKey(agentId, endedRoot))
      }
      return
    }

    // Capture media events in the pending store; never route them to agents.
    if (
      evt.type === 'm.room.message' &&
      isMediaMsgtype(evt.content?.msgtype) &&
      evt.room_id &&
      evt.event_id &&
      evt.sender &&
      evt.content?.url &&
      !bindings.some((b) => b.userId === evt.sender)
    ) {
      pendingMedia.add(evt.room_id, inboundThreadRoot(evt), {
        eventId: evt.event_id,
        sender: evt.sender,
        msgtype: evt.content.msgtype as string,
        body: (evt.content.body as string | undefined) ?? '',
        filename: evt.content.filename as string | undefined,
        url: evt.content.url as string,
        info: evt.content.info as PendingMediaItem['info'],
      })
      return
    }

    // Agent-promotion: top-level inbound event becomes the thread root.
    // For in-thread messages the existing root is preserved.
    const promotedRoot = inboundThreadRoot(evt) ?? evt.event_id
    // Self-heal: if this is a thread reply but we have no in-memory state
    // for the root (e.g. daemon was just restarted), reconstruct it by
    // fetching the thread root + relations from the server.
    const inboundRel = inboundThreadRoot(evt)
    if (
      evt.type === 'm.room.message' &&
      inboundRel &&
      !threadStates.has(inboundRel) &&
      evt.room_id
    ) {
      try {
        const rebuilt = await rebuildThreadState(client, evt.room_id, inboundRel, bindings)
        threadStates.set(inboundRel, rebuilt)
        console.log(
          `[matrix] rebuilt threadState for ${inboundRel}: participants=${rebuilt.participants.join(',')} rootMentions=${rebuilt.rootMentions.join(',')}`,
        )
      } catch (err) {
        console.warn(`[matrix] failed to rebuild threadState for ${inboundRel}:`, err)
      }
    }
    const startField = evt.content?.[THREAD_START_FIELD] as ThreadStartContent | undefined
    if (startField?.attempt_id && !inboundRel && evt.event_id)
      taskRegistry.adopt(startField.attempt_id, evt.event_id)
    if (evt.content?.[THREAD_RESULT_FIELD] !== undefined) return
    const taskRec = promotedRoot ? taskRegistry.taskForRoot(promotedRoot) : undefined
    const taskCtx =
      taskRec && taskRec.phase !== 'reserved'
        ? {
            assignee: taskRec.assignee,
            isRoot: !inboundRel && evt.event_id === taskRec.threadRoot,
          }
        : undefined
    let matches = route(evt, bindings, threadStates, taskCtx)
    // In a delegated task, agent-to-agent messages dispatch only when the
    // outgoing flush registered a matching invocation. This prevents a
    // circular handoff that was visibly refused from still waking its target.
    if (taskCtx && !taskCtx.isRoot && evt.event_id && bindings.some((b) => b.userId === evt.sender)) {
      const invocation = invocations.byCallEvent(evt.event_id)
      matches = invocation ? matches.filter((match) => match.name === invocation.calleeAgent) : []
    }
    // [[ZOD039]] A return fires at the callee's turn boundary, not per message.
    // Every tool call forces a buffer flush, so one turn posts many
    // `m.room.message`s; routing each as a return woke the caller once per
    // chunk and the pair read as re-triggering each other. Hold them and let
    // the sender's `dev.zooid.turn.end` release the lot as a single wake.
    if (evt.type === 'm.room.message' && promotedRoot && evt.room_id) {
      const senderBinding = bindings.find((b) => b.userId === evt.sender)
      if (senderBinding) {
        const st = threadStates.get(promotedRoot)
        const held = matches.filter((m) => isReturnRoute(evt, m, bindings, st))
        if (held.length > 0) {
          matches = matches.filter((m) => !held.includes(m))
          stashReturn(senderBinding, promotedRoot, evt.room_id, evt, held)
        }
      }
      // Anything we are waking now supersedes a return it was owed: an explicit
      // @mention (rule 1) or a human follow-up already carries the thread on.
      for (const m of matches) dropPendingReturn(promotedRoot, m.name)
    }

    // Suppress the no-match warning for events sent by our own bots.
    const senderIsBot = bindings.some((b) => b.userId === evt.sender)
    if (evt.type === 'm.room.message' && matches.length === 0 && !senderIsBot) {
      console.warn(
        `[matrix] no agent matched message in ${evt.room_id} from ${evt.sender}` +
          ` (bindings: ${bindings.map((b) => `${b.name}@${b.userId}[${b.trigger}]`).join(', ')})`,
      )
    }
    // Seed thread state for any agent mentions in this event.
    if (matches.length > 0 && promotedRoot) {
      let st = threadStates.get(promotedRoot)
      if (!st) {
        st = { participants: [], rootMentions: [], callers: {}, handoffs: {} }
        threadStates.set(promotedRoot, st)
      }
      if (taskCtx?.isRoot) {
        if (!st.rootMentions.includes(taskRec!.assignee)) st.rootMentions.push(taskRec!.assignee)
      } else {
        const msgMentions = new Set(extractMentions(evt as never))
        const senderAgent = bindings.find((b) => b.userId === evt.sender)
        for (const a of bindings) {
          if (!msgMentions.has(a.userId)) continue
          if (!st.rootMentions.includes(a.name)) st.rootMentions.push(a.name)
          // A mention that would close a cycle is a return addressed by name,
          // not a call: record no edge and mint no arc, or the pair bounces
          // forever and the callee loses its session to a fresh arc.
          if (
            senderAgent &&
            a.name !== senderAgent.name &&
            !wouldCycleCallers(st.callers, a.name, senderAgent.name)
          ) {
            st.callers[a.name] = senderAgent.name
            if (evt.event_id) {
              const arcs = (st.handoffs[a.name] ??= [])
              if (!arcs.includes(evt.event_id)) arcs.push(evt.event_id)
            }
          }
        }
      }
    }
    for (const a of matches) {
      console.log(`[matrix] → ${a.name} (${a.userId})`)
      if (!promotedRoot || !evt.room_id) continue
      const sessionKey = sessionKeyFor(a.name, promotedRoot, threadStates.get(promotedRoot))
      const taskEnvelope =
        taskCtx?.isRoot && a.name === taskRec!.assignee
          ? { parentAgent: taskRec!.parent.agent }
          : undefined
      void enqueueTurn(a, {
        roomId: evt.room_id,
        threadRoot: promotedRoot,
        sessionKey,
        event: evt,
        ...(taskEnvelope ? { taskEnvelope } : {}),
      })
    }
  }

  const app = new Hono()

  function authOk(authHeader: string | undefined): boolean {
    const h = authHeader ?? ''
    if (!h.startsWith('Bearer ')) return false
    const got = h.slice(7)
    if (got.length !== hsToken.length) return false
    return timingSafeEqual(Buffer.from(got), Buffer.from(hsToken))
  }

  app.put('/_matrix/app/v1/transactions/:txnId', async (c) => {
    if (!authOk(c.req.header('authorization'))) {
      return c.json({ errcode: 'M_FORBIDDEN' }, 403)
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      events?: MatrixEvent[]
    }
    for (const evt of body.events ?? []) {
      await handleInboundEvent(evt)
    }
    return c.json({})
  })

  app.get('/_matrix/app/v1/users/:userId', (c) => {
    if (!authOk(c.req.header('authorization'))) {
      return c.json({ errcode: 'M_FORBIDDEN' }, 403)
    }
    return c.json({})
  })
  app.get('/_matrix/app/v1/rooms/:alias', (c) => {
    if (!authOk(c.req.header('authorization'))) {
      return c.json({ errcode: 'M_FORBIDDEN' }, 403)
    }
    return c.json({ errcode: 'M_NOT_FOUND' }, 404)
  })
  app.post('/_matrix/app/v1/ping', (c) => {
    if (!authOk(c.req.header('authorization'))) {
      return c.json({ errcode: 'M_FORBIDDEN' }, 403)
    }
    return c.json({})
  })
  app.get('/healthz', (c) => c.text('ok'))

  async function runTurn(agent: AgentBinding, input: TurnInput): Promise<void> {
    const { roomId, threadRoot, sessionKey } = input
    // Agent-promotion: top-level inbound becomes a thread root via the agent's
    // first reply.
    // [[ZOD071]]: the session key is the agent's current handoff arc when it
    // has one, else the thread-level key. The raw threadRoot still travels
    // separately: outbound events relate to it, and it is the context ref so
    // zooid_get_history reads the real thread.
    const sessionId = await agents.ensureSession(agent.name, sessionKey, roomId, threadRoot)
    sessions.set(sessionId, { agent, roomId, threadRoot })
    buffers.set(sessionId, '')
    bufferMessageIds.delete(sessionId)
    flushedCounts.set(sessionId, 0)
    // Commands the shim advertised during ensureSession (session load/new)
    // arrived before the ctx above existed and were stashed — replay the latest
    // now that the session is fully registered, so the palette actually fills.
    const stashedCommands = pendingCommands.get(sessionId)
    if (stashedCommands) {
      pendingCommands.delete(sessionId)
      void agents.onEvent?.(agent.name, stashedCommands)
    }

    const TYPING_TTL_MS = 30_000
    const TYPING_REFRESH_MS = 25_000
    const safeTyping = (typing: boolean) =>
      client
        .setTyping({
          roomId,
          asUserId: agent.userId,
          typing,
          timeoutMs: TYPING_TTL_MS,
        })
        .catch((err) => console.warn(`[matrix:${agent.name}] setTyping(${typing}) failed:`, err))
    const safePresence = (presence: 'online' | 'unavailable' | 'offline') =>
      client
        .setPresence({ asUserId: agent.userId, presence })
        .catch((err) =>
          console.warn(`[matrix:${agent.name}] setPresence(${presence}) failed:`, err),
        )

    await safeTyping(true)
    await safePresence('unavailable')
    const refresh = setInterval(() => {
      void safeTyping(true)
    }, TYPING_REFRESH_MS)

    let turnError: unknown
    let stopReason: StopReason | undefined
    try {
      const rawBody = input.event?.content?.body ?? ''
      const strippedPromptText = input.promptText ?? stripMention(rawBody, agent.userId)
      const promptText = input.taskEnvelope
        ? renderAssigneeEnvelope({
            parentAgent: input.taskEnvelope.parentAgent,
            prompt: strippedPromptText,
          })
        : strippedPromptText

      // Drain pending media for this sender+thread and prepend as ACP content blocks.
      const pendingItems = pendingMedia.drain(
        roomId,
        input.event ? inboundThreadRoot(input.event) : undefined,
        input.event?.sender ?? '',
      )
      const { blocks, pathLines } = await buildMediaBlocks(pendingItems, {
        agent,
        media: mediaClient,
        writeAttachmentFn,
        onError: (item, err) => {
          console.warn(`[matrix:${agent.name}] media_failed for ${item.body}:`, err)
          void sendMediaError(
            { agent, roomId, threadRoot },
            err,
            `Could not process attachment: ${item.body}`,
            client,
          )
        },
      })

      const fullPromptText = [promptText, ...pathLines].filter(Boolean).join('\n')
      const promptResult = await agents.prompt(agent.name, {
        threadId: sessionKey,
        channelId: roomId,
        contextThreadId: threadRoot,
        content: [...blocks, { type: 'text', text: fullPromptText }],
      })
      stopReason = promptResult.stopReason as StopReason
      // Drain: the prompt promise resolves on the stopReason response, but
      // trailing chunks may still arrive (see DRAIN_* above). Wait until the
      // buffer is quiet for DRAIN_QUIET_MS, re-arming on each new chunk.
      //
      // Subtlety: some agents (opencode in particular) resolve `session/prompt`
      // *before* the agent_message_chunk stream starts. So the buffer can be
      // empty for several seconds after prompt resolves, and only then do the
      // chunks arrive. We can't break the drain just because the buffer is
      // empty — we have to wait up to drainMaxMs for chunks to *start*. Once
      // any content arrives, the "quiet for drainQuietMs" rule kicks in.
      const drainStart = Date.now()
      let drained = buffers.get(sessionId) ?? ''
      while (drainQuietMs > 0 && Date.now() - drainStart < drainMaxMs) {
        await delay(drainQuietMs)
        const next = buffers.get(sessionId) ?? ''
        // Stop when the buffer is quiet (unchanged) and either it holds the
        // final message to flush, or we already flushed a message this turn
        // (so an empty, quiet buffer means the turn is genuinely done — the
        // last message was flushed mid-stream). An unchanged *empty* buffer
        // with nothing flushed yet means the stream hasn't started; keep
        // waiting up to drainMaxMs.
        if (next === drained && (next.length > 0 || (flushedCounts.get(sessionId) ?? 0) > 0)) break
        drained = next
      }
      // Flush the final assistant message — the one with no following messageId
      // change or out-of-band event to have triggered an earlier flush.
      flushBuffer(sessionId)
    } catch (err) {
      turnError = err
      throw err
    } finally {
      clearInterval(refresh)
      await safeTyping(false)
      await safePresence('online')
      // Wait for every queued send (mid-turn flushes, tool/plan events, final
      // flush) to settle before announcing the turn's end — and run this even
      // when the turn above threw, so the room never hangs on a spinner.
      await (sendQueue.get(sessionId) ?? Promise.resolve())
      // Finalize the per-turn mirror line (if the turn touched any tools) to
      // `✅ N tools · M files`, or `⚠️` when the turn failed. Done before the
      // turn.end below so the boundary lands after the finalized line.
      await finalizeTurnMirror(
        sessionId,
        { agent, roomId, threadRoot },
        turnError !== undefined,
      )
      const producedOutput = (flushedCounts.get(sessionId) ?? 0) > 0
      if (!producedOutput) {
        console.warn(
          `[matrix:${agent.name}] turn finished with empty buffer (session=${sessionId}); nothing sent to ${roomId}`,
        )
      }
      // Turn boundary for [[ZOD076]] and push notifications. Sent after the
      // send queue drains so it lands *after* the prose it announces — a
      // turn.end arriving first would notify the user to look at a room that
      // has nothing in it yet.
      await client
        .sendCustomEvent({
          roomId,
          asUserId: agent.userId,
          eventType: 'dev.zooid.turn.end',
          content: toTurnEndBody(
            {
              agentId: agent.name,
              sessionId,
              producedOutput,
              lastMessage: lastFlushed.get(sessionId),
            },
            threadRoot,
          ),
        })
        .catch((e) => console.warn(`[matrix:${agent.name}] turn.end send failed:`, e))
      const task = taskRegistry.taskForRoot(threadRoot)
      const invocation = invocations.forCalleeSession(sessionKey)
      const isAssignee = task?.phase === 'open' && task.assignee === agent.name && task.threadRoot === sessionKey
      if (task?.phase === 'open' && (isAssignee || invocation?.state === 'outstanding')) {
        const decision = evaluateCompletion({
          agent: agent.name,
          threadId: isAssignee ? threadRoot : (invocation?.calleeSessionKey ?? sessionKey),
          stopReason,
          error: turnError,
          summary: isAssignee ? task.summary : undefined,
          prose: lastFlushed.get(sessionId),
          outstanding: invocations.outstandingFor(sessionKey).length,
          awaitingHuman: pendingInput.countFor(sessionKey),
        })
        if (decision.decision === 'finish') {
          if (isAssignee) await finishTask(task, { agent, completion: decision.completion })
          else if (invocation) returnInvocation(invocation, decision.completion, task)
        }
      }
      buffers.delete(sessionId)
      bufferMessageIds.delete(sessionId)
      flushedCounts.delete(sessionId)
      lastFlushed.delete(sessionId)
      sendQueue.delete(sessionId)
      turnMirrors.delete(sessionId)
    }
  }

  async function finishTask(
    task: TaskRecord,
    ctx: { agent: AgentBinding; completion: ThreadCompletion },
  ): Promise<void> {
    const threadId = task.threadRoot!
    const completion = ctx.completion
    if (!taskRegistry.close(task.taskId)) return
    const cancelled = invocations.cancelForTask(task.taskId)
    pendingInput.cancelFor([threadId, ...cancelled.map((i) => i.calleeSessionKey).filter((x): x is string => Boolean(x))])
    await client.sendCustomEvent({
      roomId: task.roomId,
      asUserId: ctx.agent.userId,
      eventType: THREAD_RESULT_FIELD,
      content: {
        ...completion,
        'm.relates_to': { rel_type: 'm.thread', event_id: threadId },
      },
    })
    if (task.summary && task.summary !== completion.output?.text)
      await client.sendMessage({
        roomId: task.roomId,
        asUserId: ctx.agent.userId,
        threadRoot: threadId,
        content: buildTextContent(task.summary),
      })
    if (task.notify === 'none') return
    const parent = bindingFor(task.parent.agent)
    await client.sendMessage({
      roomId: task.roomId,
      asUserId: ctx.agent.userId,
      threadRoot: task.parent.threadRoot,
      content: {
        msgtype: 'm.notice',
        body: renderCompletionPrompt(completion),
        [THREAD_RESULT_FIELD]: completion,
      },
    })
    if (
      !parent ||
      taskRegistry.generationOf(task.parent.agent, task.parent.sessionKey) !==
        task.parent.generation
    )
      return
    void enqueueTurn(parent, {
      roomId: task.roomId,
      threadRoot: task.parent.threadRoot,
      sessionKey: task.parent.sessionKey,
      promptText: renderCompletionPrompt(completion),
    })
  }

  function returnInvocation(invocation: import('@zooid/core').InvocationRecord, completion: ThreadCompletion, task: TaskRecord): void {
    const resolved = invocations.resolve(invocation.invocationId)
    if (!resolved || task.phase !== 'open') return
    const caller = bindingFor(resolved.callerAgent)
    if (!caller || !task.threadRoot) return
    void enqueueTurn(caller, {
      roomId: task.roomId,
      threadRoot: task.threadRoot,
      sessionKey: resolved.callerSessionKey,
      promptText: renderInvocationReturn(completion),
    })
  }

  const taskActions: TaskActions = {
    async startTasks(caller, input) {
      const notify = input.notify ?? 'caller'
      const results: StartTaskResult[] = new Array(input.tasks.length)
      const callerBinding = bindingFor(caller.agentName)
      const enclosing = taskRegistry.taskForRoot(caller.threadRoot)
      const admitted: Array<{
        index: number
        spec: StartTaskSpec
        rec: TaskRecord
      }> = []
      for (const [index, spec] of input.tasks.entries()) {
        if (!callerBinding) {
          results[index] = {
            agent: spec.agent,
            status: 'refused',
            reason: 'unknown_caller',
          }
          continue
        }
        if (enclosing) {
          results[index] = {
            agent: spec.agent,
            status: 'refused',
            reason:
              'depth_limit: this thread is itself a delegated task. Do the work here, or @mention another agent in this thread to hand off.',
          }
          continue
        }
        const admission = checkDelegable(spec.agent, caller.channelId, bindings)
        if (!admission.ok) {
          results[index] = {
            agent: spec.agent,
            status: 'refused',
            reason: admission.reason,
          }
          continue
        }
        const rec = taskRegistry.reserve({
          roomId: caller.channelId,
          assignee: spec.agent,
          notify,
          parent: {
            agent: caller.agentName,
            threadRoot: caller.threadRoot,
            sessionKey: caller.sessionKey,
            generation: taskRegistry.generationOf(caller.agentName, caller.sessionKey),
          },
        })
        if (!rec) {
          results[index] = {
            agent: spec.agent,
            status: 'refused',
            reason: `at_capacity: ${MAX_OPEN_TASKS_PER_ROOM} tasks are already open in this room. Wait for one to finish.`,
          }
          continue
        }
        admitted.push({ index, spec, rec })
      }
      await Promise.all(
        admitted.map(async ({ index, spec, rec }) => {
          const assignee = bindingFor(spec.agent)!
          const content = buildAssignmentContent({
            assigneeUserId: assignee.userId,
            prompt: spec.prompt,
            start: {
              version: 1,
              assignee: spec.agent,
              attempt_id: rec.attemptId,
              parent: {
                agent: rec.parent.agent,
                thread_root: rec.parent.threadRoot,
                session_key: rec.parent.sessionKey,
              },
              notify,
            },
          })
          const post = () =>
            client.sendMessage({
              roomId: caller.channelId,
              asUserId: callerBinding!.userId,
              content,
              txnId: rec.attemptId,
            })
          try {
            const { event_id } = await post()
            taskRegistry.activate(rec.taskId, event_id)
            results[index] = {
              agent: spec.agent,
              status: 'started',
              thread_id: event_id,
            }
          } catch {
            try {
              const { event_id } = await post()
              taskRegistry.activate(rec.taskId, event_id)
              results[index] = {
                agent: spec.agent,
                status: 'started',
                thread_id: event_id,
              }
            } catch (second) {
              const status = (second as { status?: number }).status
              if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
                taskRegistry.abandon(rec.taskId)
                results[index] = {
                  agent: spec.agent,
                  status: 'failed',
                  reason: `post_failed: ${String((second as Error).message)}`,
                }
              } else {
                taskRegistry.markUncertain(rec.taskId)
                results[index] = {
                  agent: spec.agent,
                  status: 'failed',
                  reason: `post_uncertain: ${String((second as Error).message)}`,
                  attempt_id: rec.attemptId,
                }
              }
            }
          }
        }),
      )
      return { results, notify, delivery: renderDelivery(notify) }
    },
    async completeTask(caller, input) {
      const summary = input.summary.trim()
      if (!summary) return { status: 'refused', reason: 'summary must be non-empty' }
      const rec = taskRegistry.openTaskFor(caller.agentName, caller.threadRoot)
      if (!rec || rec.threadRoot !== caller.sessionKey)
        return {
          status: 'refused',
          reason: 'no_open_task: this session is not the assignee of an open task',
        }
      if (invocations.outstandingFor(caller.sessionKey).length)
        return { status: 'refused', reason: 'outstanding_handoff: wait for delegated work to return' }
      return { status: taskRegistry.recordSummary(rec.taskId, summary) }
    },
    async describeRole(caller) {
      const enclosing = taskRegistry.taskForRoot(caller.threadRoot)
      const openTask = taskRegistry.openTaskFor(caller.agentName, caller.threadRoot)
      return {
        is_task_assignee: openTask !== undefined && openTask.threadRoot === caller.sessionKey,
        can_start_task_threads: enclosing === undefined,
      }
    },
  }

  // Journal reconciliation happens after functions are initialized, but before
  // the daemon starts accepting work. A prior run has no ACP turn to supply a
  // terminal boundary, so publish its durable cancellation directly.
  queueMicrotask(() => {
    for (const task of interruptedTasks) {
      if (!task.threadRoot) continue
      const assignee = bindingFor(task.assignee)
      if (!assignee) continue
      const completion: ThreadCompletion = {
        agent: task.assignee, thread_id: task.threadRoot, status: 'cancelled', reason: 'interrupted_by_restart',
      }
      void client.sendCustomEvent({
        roomId: task.roomId, asUserId: assignee.userId, eventType: THREAD_RESULT_FIELD,
        content: { ...completion, 'm.relates_to': { rel_type: 'm.thread', event_id: task.threadRoot } },
      })
      if (task.notify !== 'none') {
        const parent = bindingFor(task.parent.agent)
        if (
          parent &&
          taskRegistry.generationOf(task.parent.agent, task.parent.sessionKey) === task.parent.generation
        ) {
          void client.sendMessage({
            roomId: task.roomId,
            asUserId: assignee.userId,
            threadRoot: task.parent.threadRoot,
            content: {
              msgtype: 'm.notice',
              body: renderCompletionPrompt(completion),
              [THREAD_RESULT_FIELD]: completion,
            },
          })
          void enqueueTurn(parent, { roomId: task.roomId, threadRoot: task.parent.threadRoot, sessionKey: task.parent.sessionKey, promptText: renderCompletionPrompt(completion) })
        }
      }
    }
  })

  const syncLoops: SyncLoop[] | undefined =
    mode === 'client'
      ? bindings.map(
          (b) =>
            new SyncLoop({
              client: client as never,
              asUserId: b.userId,
              loadSince: () => opts.loadSince?.(b.userId) ?? null,
              saveSince: (since) => opts.saveSince?.(b.userId, since),
              onEvent: (evt) => handleInboundEvent(evt as MatrixEvent),
            }),
        )
      : undefined

  return {
    app,
    taskActions,
    syncLoops,
    bootstrap: async (
      bootstrapOpts: {
        spaceRoomId?: string
        asUserId?: string
        adminUserIds?: string[]
      } = {},
    ) => {
      await pool.bootstrap({ adminUserId, ...bootstrapOpts })
      await Promise.allSettled(
        bindings.map((b) =>
          client.setPresence({ asUserId: b.userId, presence: 'online' }).catch((err) => {
            console.warn(`[matrix:${b.name}] initial setPresence(online) failed:`, err)
          }),
        ),
      )
    },
    pool,
  }
}

/**
 * Reconstruct the in-memory ThreadState for a thread root by fetching the
 * root event + its thread relations from the server. Used to recover the
 * implicit-routing rule from ZOD039 § Implicit triggers in threads after a
 * daemon restart wipes the in-memory cache.
 */
export async function rebuildThreadState(
  client: MatrixClient,
  roomId: string,
  rootEventId: string,
  bindings: AgentBinding[],
): Promise<ThreadState> {
  const state: ThreadState = {
    participants: [],
    rootMentions: [],
    callers: {},
    handoffs: {},
  }
  // Impersonate an agent that's actually a member of this room (AS reads
  // require room membership). Falling through to the first binding would
  // 403 if that agent never joined the target room.
  const asUser = (bindings.find((b) => b.rooms.some((r) => r.alias === roomId)) ?? bindings[0])
    ?.userId
  if (!asUser) return state

  const root = await client.fetchEvent(roomId, rootEventId, asUser)
  if (root) {
    const rootMentions = new Set(extractMentions(root as never))
    const rootSender = (root as { sender?: string }).sender
    const rootSenderAgent = rootSender ? bindings.find((b) => b.userId === rootSender) : undefined
    for (const a of bindings) {
      if (!rootMentions.has(a.userId)) continue
      if (!state.rootMentions.includes(a.name)) state.rootMentions.push(a.name)
      if (
        rootSenderAgent &&
        a.name !== rootSenderAgent.name &&
        !wouldCycleCallers(state.callers, a.name, rootSenderAgent.name)
      ) {
        state.callers[a.name] = rootSenderAgent.name
        const arcs = (state.handoffs[a.name] ??= [])
        if (!arcs.includes(rootEventId)) arcs.push(rootEventId)
      }
    }
  }

  const { chunk: thread } = await client.fetchThreadRelations({
    roomId,
    rootEventId,
    asUserId: asUser,
  })
  // Also seed root-mentions from any subsequent agent @mentions in the thread.
  for (const ev of thread) {
    const mentions = new Set(extractMentions(ev as never))
    const evSender = (ev as { sender?: string }).sender
    const evSenderAgent = evSender ? bindings.find((b) => b.userId === evSender) : undefined
    const evId = (ev as { event_id?: string }).event_id
    for (const a of bindings) {
      if (!mentions.has(a.userId)) continue
      if (!state.rootMentions.includes(a.name)) state.rootMentions.push(a.name)
      if (
        evSenderAgent &&
        a.name !== evSenderAgent.name &&
        !wouldCycleCallers(state.callers, a.name, evSenderAgent.name)
      ) {
        state.callers[a.name] = evSenderAgent.name
        if (evId) {
          const arcs = (state.handoffs[a.name] ??= [])
          if (!arcs.includes(evId)) arcs.push(evId)
        }
      }
    }
    const type = (ev as { type?: string }).type
    if (type === 'm.room.message' && evSender) {
      const a = bindings.find((b) => b.userId === evSender)
      if (a && state.participants.at(-1) !== a.name) state.participants.push(a.name)
    }
  }
  return state
}

function logInbound(evt: MatrixEvent): void {
  const sender = evt.sender ?? '?'
  const room = evt.room_id ?? '?'
  const type = evt.type ?? '?'
  if (type === 'm.room.message') {
    const body = evt.content?.body ?? ''
    const mentions = (evt.content?.['m.mentions'] as { user_ids?: string[] } | undefined)?.user_ids
    const mentionsStr = mentions?.length ? ` mentions=${JSON.stringify(mentions)}` : ''
    console.log(
      `[matrix] inbound msg in ${room} from ${sender}${mentionsStr}: ${truncate(body, 200)}`,
    )
  } else {
    console.log(`[matrix] inbound ${type} in ${room} from ${sender}`)
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}
