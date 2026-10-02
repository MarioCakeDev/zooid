import type {
  ContentBlock,
  PlanEntry,
  StopReason,
  ToolCallContent,
  ToolCallStatus,
  ToolKind,
} from '@agentclientprotocol/sdk'

export type { ContentBlock }
import type { PresetName } from './presets.js'

/**
 * Structural copy of `@zooid/core`'s `AcpMount` shape. Kept here to avoid a
 * back-edge to core; both files describe the same `{ path, target, mode }`
 * tuple the docker runtime consumes.
 */
export interface AcpMountSpec {
  path: string
  target: string
  mode: 'ro' | 'rw'
}

export interface AgentConfig {
  id: string
  /** Short-hand for a known ACP harness. Resolves to command/args via the preset registry. */
  preset?: PresetName
  /** Optional model id, forwarded to the preset as `--model <id>` where supported. */
  model?: string
  /** Explicit command. Overrides whatever the preset would set. */
  command?: string
  /** Explicit args. Overrides whatever the preset would set. */
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  /** Container image. Forwarded to the spawn runtime; ignored by host-spawn paths. */
  image?: string
  /** Bind mounts. Forwarded to the spawn runtime; ignored by host-spawn paths. */
  mounts?: AcpMountSpec[]
}

export interface PromptInput {
  threadId: string
  /**
   * Channel/room id this thread lives in. Optional — when omitted, callers
   * (transports that don't model a separate channel, e.g. HTTP) treat
   * `threadId` as both. Matrix passes `evt.room_id` here so the
   * transport-context provider sees the real room.
   */
  channelId?: string
  /**
   * The real thread root when `threadId` is a composed handoff-arc session
   * key ([[ZOD071]]). Feeds the transport-context spawn so history reads
   * target the real thread. Defaults to `threadId`.
   */
  contextThreadId?: string
  content: ContentBlock[]
}

export interface PromptResult {
  stopReason: StopReason
  /**
   * The ACP session id the turn actually ran on. Normally the id the caller
   * already has; it changes when the daemon had to recover from a wedged
   * session and replay the prompt on a fresh one. Callers key per-session state
   * by id, so they should re-read it from here.
   */
  sessionId?: string
}

export type AgentEvent =
  | AgentMessageChunkEvent
  | ToolCallEvent
  | ToolCallUpdateEvent
  | PlanEvent
  | AvailableCommandsEvent
  | SessionWedgeEvent

/**
 * A prompt produced no agent output at all within the first-response deadline,
 * so the daemon threw the session away and moved on. Emitted *only* when the
 * daemon has something to tell the owner about it — transports should
 * surface it in-thread instead of letting the turn look like it silently
 * ended, because the owner's only other signal is absence.
 */
export interface SessionWedgeEvent {
  type: 'session_wedge'
  /** Session the wedge was detected on. May already be gone when it arrives. */
  sessionId: string | null
  /**
   * True when the daemon recovered and the prompt is being replayed on a fresh
   * session; false when the retry budget is exhausted and the turn failed.
   */
  recovered: boolean
  /** Replay attempt this notice belongs to (1 = the wedge itself). */
  attempt: number
  /** Total attempts allowed for this prompt. */
  maxAttempts: number
  /** Session id the prompt was replayed on, when `recovered`. */
  recoveredSessionId?: string
}

export interface AvailableCommandsEvent {
  type: 'available_commands'
  sessionId: string
  commands: Array<{ name: string; description: string }>
}

export interface AgentMessageChunkEvent {
  type: 'agent_message_chunk'
  sessionId: string
  content: ContentBlock
  /**
   * Identifier of the assistant message this chunk belongs to, when the agent
   * supplies one (opencode does; Claude Code does not). Lets transports detect
   * message boundaries — a new id means a new message, which agents emit
   * without any delimiter chunk between them. Undefined when not provided.
   */
  messageId?: string
}

export interface ToolCallLocation {
  path: string
  line?: number
}

export interface ToolCallEvent {
  type: 'tool_call'
  sessionId: string
  toolCallId: string
  title: string
  kind?: ToolKind
  status?: ToolCallStatus
  rawInput?: unknown
  locations?: ToolCallLocation[]
}

export interface ToolCallUpdateEvent {
  type: 'tool_call_update'
  sessionId: string
  toolCallId: string
  /**
   * Updated human-readable title. opencode re-sends the tool name (and its
   * argument summary) on every update; the transport relies on it to tell a
   * whole-file `write` apart from an in-place `edit`, both of which ACP reports
   * as `kind: "edit"` (ACP has no `write` kind).
   */
  title?: string
  status?: ToolCallStatus
  kind?: ToolKind
  content?: ToolCallContent[]
  rawInput?: unknown
  rawOutput?: unknown
  locations?: ToolCallLocation[]
}

export interface PlanEvent {
  type: 'plan'
  sessionId: string
  entries: PlanEntry[]
}

export interface ApprovalRequest {
  sessionId: string
  toolCallId: string
  /** ACP tool kind (e.g. "edit", "fetch", "execute"). */
  toolKind?: string
  /** Short human-readable title from the agent (e.g. "webfetch"). */
  toolTitle?: string
  /** Raw structured tool input, shape varies by kind. */
  toolInput?: unknown
  options: Array<{ optionId: string; name: string; kind: string }>
}

export type ApprovalDecision =
  | { decision: 'allow'; optionId: string }
  | { decision: 'cancel' }
