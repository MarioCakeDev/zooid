import type { RoomBinding } from '@zooid/core'
import { TURN_MIRROR_MARKER, COMPLETION_NOTICE_MARKER } from './event-encoders.js'
import { extractMentions } from './mentions.js'
import { isExpiredTrigger } from './trigger-freshness.js'
import { readHandoff } from './handoff.js'

export type { RoomBinding }

export interface AgentBinding {
  name: string
  userId: string
  /** Optional human-readable display name. Falls back to the user_id localpart. */
  displayName?: string
  /**
   * Rooms this agent is bound to. Each entry's `alias` starts out as the
   * configured `#alias` (or `!id`) and is rewritten to the canonical room
   * ID by `BotPool.bootstrap`. Optional `powerLevel` is seeded into the
   * room's `m.room.power_levels.users` at room creation only.
   */
  rooms: RoomBinding[]
  trigger: 'mention' | 'any'
  /** Host path of the agent's workspace (resolved agent.workdir). Media files land here. */
  workspaceDir?: string
  /** Path prefix as the agent sees it: '/workspace' for containers, = workspaceDir for local. */
  agentWorkspacePath?: string
  /**
   * Opt-in: when true, a *thread-master* turn on a human-rooted thread posts a
   * top-level completion notice. Resolved at daemon start from
   * `announce.human_thread_completion` (workforce default overridden per agent).
   */
  announceHumanThreadCompletion?: boolean
}

export const MEDIA_MSGTYPES = new Set(['m.image', 'm.file', 'm.video', 'm.audio'])

export function isMediaMsgtype(t: string | undefined): boolean {
  return t !== undefined && MEDIA_MSGTYPES.has(t)
}

/**
 * True when a Matrix message is the transport's own per-turn display mirror
 * rather than real content. The marker rides on the notice and is repeated in
 * `m.new_content`, which is the content a client applies for an `m.replace`
 * edit, so both the create and each edit are recognised.
 *
 * The mirror echoes tool activity verbatim, and a context-MCP result such as
 * `zooid_get_history` quotes old messages — including their `@agent` mentions.
 * Routing must never treat that as a fresh mention, or an agent wakes itself
 * or a peer in a loop with no actual question. See [[ZOD039]].
 */
export function isMirrorNotice(content: Record<string, unknown> | undefined): boolean {
  if (!content) return false
  if (content[TURN_MIRROR_MARKER] === true) return true
  const replacement = content['m.new_content']
  return (
    typeof replacement === 'object' &&
    replacement !== null &&
    (replacement as Record<string, unknown>)[TURN_MIRROR_MARKER] === true
  )
}

export interface ThreadState {
  /**
   * Agents that have posted in this thread, in order: this daemon's agents by
   * name, other workstations' agents by MXID. Only the last entry matters to
   * routing — a remote agent posting last means no local agent is listening.
   */
  participants: string[]
  /** Agent names @mentioned in the thread root event (or subsequently). */
  rootMentions: string[]
  /**
   * Agent-to-agent call edges: callee MXID → caller MXID. Recorded only from
   * structured `dev.zooid.handoff` events, never from prose or mentions. A
   * sub's bare reply bubbles up to its caller; a caller never implicitly
   * re-triggers its callee. Makes agent↔agent acknowledgement loops
   * structurally impossible. See [[ZOD039]] § Implicit triggers → Directional
   * continuation, and [[ZOD092]] § Call graph keyed by MXID.
   */
  callers: Record<string, string>
  /**
   * Handoff arcs per callee MXID: the event ids of the `dev.zooid.handoff`
   * messages that called it, in timeline order (last = current arc). Each
   * call opens a fresh ACP session keyed `threadRoot|callEventId`
   * ([[ZOD071]]). Append-only; rebuilt from the timeline after a restart.
   */
  handoffs: Record<string, string[]>
  /**
   * MXID of the event that rooted the thread. Set on promotion (top-level
   * trigger) and on rebuild after a restart. Used by the opt-in human-thread
   * completion announcement to tell a human root from an agent / trigger /
   * brief root.
   */
  rootSender?: string
  /** True when the thread root carried a `dev.zooid.trigger` stamp. */
  rootIsTrigger?: boolean
}

export interface TaskThreadContext {
  assignee: string
  isRoot: boolean
}

interface MaybeEvent {
  type?: string
  room_id?: string
  sender?: string
  content?: {
    msgtype?: string
    'm.relates_to'?: { rel_type?: string; event_id?: string }
    'dev.zooid.trigger'?: { name?: string; fired_at?: number; ttl_ms?: number }
  }
}

export type RouteMatch = AgentBinding

function inboundThreadRoot(event: MaybeEvent): string | undefined {
  const r = event.content?.['m.relates_to']
  return r?.rel_type === 'm.thread' && r.event_id ? r.event_id : undefined
}

export function route(
  event: MaybeEvent,
  agents: AgentBinding[],
  threadStates?: Map<string, ThreadState>,
  task?: TaskThreadContext,
  /**
   * MXIDs of every agent in the workforce, including other workstations'
   * (from their `dev.zooid.workforce` rosters). `agents` holds only this
   * daemon's bindings.
   */
  knownAgentIds?: ReadonlySet<string>,
): RouteMatch[] {
  if (event.type !== 'm.room.message') return []
  if (!event.content?.msgtype) return []
  if (isMediaMsgtype(event.content.msgtype)) return []
  if (isMirrorNotice(event.content as Record<string, unknown> | undefined)) return []
  // The opt-in top-level completion notice is a sibling agent's status signal,
  // not content to route: a `trigger: any` agent would otherwise wake on it.
  if ((event.content as Record<string, unknown> | undefined)?.[COMPLETION_NOTICE_MARKER] === true)
    return []
  if (isExpiredTrigger(event, Date.now())) {
    const stamp = event.content['dev.zooid.trigger']
    const ageMs = stamp?.fired_at !== undefined ? Date.now() - stamp.fired_at : undefined
    console.info(
      `[router] dropping expired trigger "${stamp?.name ?? 'unknown'}"` +
        (ageMs !== undefined ? ` fired ${ageMs}ms ago` : ''),
    )
    return []
  }
  const mentions = new Set(extractMentions(event as never))
  const matches: RouteMatch[] = []
  const threadRoot = inboundThreadRoot(event)
  const threadState = threadRoot ? threadStates?.get(threadRoot) : undefined
  // Another workstation's agent is not a human: it continues a thread only by
  // explicit @mention, never through the human follow-up rules, or two daemons
  // wake each other's agents forever. An m.notice from an unrostered sender
  // counts too — Matrix bots post notices, and the web client never does.
  const senderIsAgent =
    agents.some((x) => x.userId === event.sender) ||
    (event.sender !== undefined && knownAgentIds?.has(event.sender) === true) ||
    event.content.msgtype === 'm.notice'
  // A human who @mentions an agent — ours or another workstation's — is
  // addressing it; implicit continuation (rule 2/3, task-assignee steering)
  // must not also fire for someone else.
  const addressesAgent = [...mentions].some(
    (id) =>
      id !== event.sender &&
      (knownAgentIds?.has(id) === true ||
        agents.some((x) => x.userId === id && x.rooms.some((r) => r.alias === event.room_id))),
  )

  const handoff = readHandoff(event.content)
  for (const a of agents) {
    if (!a.rooms.some((r) => r.alias === event.room_id)) continue
    if (task?.isRoot) {
      if (a.name === task.assignee) matches.push(a)
      continue
    }
    if (event.sender === a.userId) continue
    // [[ZOD092]] An agent calls another agent only through a structured
    // handoff whose caller is the sender. Agent prose — relayed instructions,
    // status reports, zooid_send_message posts — never calls, whatever IDs it
    // contains. Humans are unaffected.
    const called = senderIsAgent && handoff?.caller === event.sender && handoff?.callee === a.userId
    if (task) {
      if (senderIsAgent) {
        // A delegated task returns at an invocation terminal boundary, never
        // because a callee happened to post progress prose — except an
        // in-thread handoff, which is how a task-thread delegation opens.
        if (called) matches.push(a)
        continue
      }
      if (mentions.has(a.userId)) matches.push(a)
      else if (a.name === task.assignee && !addressesAgent) matches.push(a)
      continue
    }
    if (a.trigger === 'any') {
      matches.push(a)
      continue
    }
    // trigger === 'mention'
    if (senderIsAgent) {
      // Agent reply: only a structured call, or a "return" — the agent that
      // called the sender (its caller), never a callee. Directional
      // continuation keeps agent↔agent handoffs from looping — the call graph
      // is a tree rooted at the human, so returns only ever walk up.
      if (called || isReturnRoute(event, a, threadState)) matches.push(a)
      continue
    }
    if (mentions.has(a.userId)) {
      matches.push(a)
      continue
    }
    // Implicit trigger in a thread.
    if (threadState && !addressesAgent) {
      // Human (or non-agent) bare follow-up: continue with the most-recent-
      // posting agent, or inherit the root mention if no agent has posted
      // yet. An explicit @mention transfers attention instead ([[ZOD039]]).
      const lastPoster = threadState.participants.at(-1)
      if (lastPoster) {
        if (lastPoster === a.name) matches.push(a)
      } else if (threadState.rootMentions.includes(a.name)) {
        matches.push(a)
      }
    }
  }
  return matches
}

/**
 * True when routing `event` to `agent` is a *return* — a callee's reply
 * bubbling up to the agent that called it — rather than a fresh call or a
 * human follow-up.
 *
 * The transport defers returns to the sender's turn boundary. An agent turn
 * posts one `m.room.message` per buffered chunk (every tool call forces a
 * flush), so treating each chunk as a return woke the caller once per chunk
 * and the two agents read as re-triggering each other. See [[ZOD039]]
 * § Implicit triggers → Directional continuation.
 *
 * [[ZOD092]] Keyed by MXID, so a callee on another workstation returns to its
 * caller here exactly as a local one does.
 */
export function isReturnRoute(
  event: MaybeEvent,
  agent: AgentBinding,
  threadState: ThreadState | undefined,
): boolean {
  if (!threadState || agent.trigger !== 'mention') return false
  const sender = event.sender
  if (!sender || sender === agent.userId) return false
  return threadState.callers[sender] === agent.userId
}

/**
 * True when recording `callee`’s caller as `caller` would put a cycle in the
 * call graph — i.e. `callee` is already an ancestor of `caller`. The graph has
 * to stay a tree rooted at the human, because `route` walks it upward on every
 * return; a 2-cycle (A calls B, B @mentions A back) would bounce forever.
 * A mention that would close a cycle is a return, not a call, so it routes but
 * records no edge.
 */
export function wouldCycleCallers(
  callers: Record<string, string>,
  callee: string,
  caller: string,
): boolean {
  const seen = new Set<string>()
  let cursor: string | undefined = caller
  while (cursor !== undefined) {
    if (cursor === callee || seen.has(cursor)) return true
    seen.add(cursor)
    cursor = callers[cursor]
  }
  return false
}
