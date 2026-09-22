import type {
  TransportContextProvider,
  HistoryOptions,
  HistoryPage,
  Member,
  RoomInfo,
  SendMessageInput,
  SendMessageResult,
  Message,
  ThreadOverview,
  ThreadOverviewPage,
} from '@zooid/core'
import type { MatrixClient } from './matrix-client.js'
import type { RoomBinding } from '@zooid/core'

interface MatrixMessageEvent {
  event_id: string
  sender: string
  origin_server_ts: number
  type: string
  content?: {
    msgtype?: string
    body?: string
    'm.relates_to'?: { rel_type?: string; event_id?: string }
  }
  unsigned?: {
    'm.relations'?: {
      'm.thread'?: {
        count?: number
        latest_event?: { origin_server_ts?: number }
      }
    }
  }
}

export interface MatrixContextProviderOpts {
  client: MatrixClient
  /**
   * The **agent's own** Matrix user (`@{workstation}.{name}:server`), which
   * every read is impersonated as via `?user_id=`. Not the AS bot: that would
   * read every room on the homeserver and make this class the only thing
   * standing between an agent and someone else's conversation.
   *
   * This is load-bearing. It is what makes the homeserver — not our own
   * bookkeeping — the authorization boundary for context reads, so a room or
   * thread the agent is not in fails at Matrix with 403/404. Anything that
   * widens who can name a room (a CLI, a new tool parameter) is safe only
   * while this holds.
   */
  asUserId: string
  /** Map of Matrix user IDs → agent names, for is_agent / agent_name flags. */
  agentBots: Map<string, string>
  /**
   * This agent's own room bindings — the live array `BotPool.bootstrap`
   * rewrites `.alias` on in place, so reads through this field after
   * bootstrap see canonical room IDs. Backs `getRooms()` and the
   * `sendMessage()` authorization check. Absent/empty = no rooms known
   * (context providers built before this field existed, or in tests that
   * don't exercise either method).
   */
  rooms?: RoomBinding[]
}

/**
 * True when the homeserver refused a message because its `m.relates_to` thread
 * relation points at a root event in another room. Synapse/Tuwunel answer this
 * with `400 M_INVALID_PARAM` and the body "Relations must be in the same room".
 * Match the phrase, not the errcode — `M_INVALID_PARAM` covers many unrelated
 * 400s, and treating those as a relation mismatch would silently drop a valid
 * thread instead of surfacing the real error.
 */
function isRelationRoomMismatch(err: unknown): boolean {
  const e = err as { status?: number; message?: string }
  return e?.status === 400 && /relations must be in the same room/i.test(e.message ?? '')
}

function topLevelFallback(rootId: string, roomId: string): string {
  return `thread ${rootId} is not in ${roomId}; posted top-level instead`
}

export class MatrixContextProvider implements TransportContextProvider {
  /**
   * Thread root event id → the room it lives in. A thread belongs to exactly
   * one room, so a positive hit lets `sendMessage` reject a mismatched target
   * room without a probe. Misses (`threadRoomMisses`) are cached too: an event
   * id is immutable, so "root not in room X" cannot become true later.
   */
  private readonly threadRooms = new Map<string, string>()
  private readonly threadRoomMisses = new Set<string>()

  constructor(private readonly opts: MatrixContextProviderOpts) {}

  async getRoomHistory(channelId: string, hopts: HistoryOptions): Promise<HistoryPage> {
    // Server-side filter: only `m.room.message` events. Without this we'd
    // burn the page budget on reactions, `dev.zooid.*` custom events, typing
    // notifications, etc., and routinely return empty pages with a stale
    // `has_more` cursor.
    const { chunk, end } = await this.opts.client.fetchRoomMessages({
      roomId: channelId,
      asUserId: this.opts.asUserId,
      limit: hopts.limit,
      from: hopts.before,
      filter: { types: ['m.room.message'] },
    })
    const messages: Message[] = []
    for (let i = chunk.length - 1; i >= 0; i--) {
      const ev = chunk[i] as unknown as MatrixMessageEvent
      const msg = this.toMessage(ev)
      if (msg) messages.push(msg)
    }
    return {
      messages,
      next_before: end,
      has_more: end !== undefined,
    }
  }

  async getRecentThreads(
    channelId: string,
    hopts: HistoryOptions,
  ): Promise<ThreadOverviewPage> {
    // Server-side filter: `m.room.message` only, and exclude thread replies
    // (`not_rel_types: ['m.thread']`) so the overview shows top-level entries
    // and thread roots, not the reply noise underneath them.
    const { chunk, end } = await this.opts.client.fetchRoomMessages({
      roomId: channelId,
      asUserId: this.opts.asUserId,
      limit: hopts.limit,
      from: hopts.before,
      filter: { types: ['m.room.message'], not_rel_types: ['m.thread'] },
    })
    // /messages returns newest-first; keep that order for the overview.
    const threads: ThreadOverview[] = []
    for (const ev of chunk as unknown as MatrixMessageEvent[]) {
      if (ev.type !== 'm.room.message') continue
      // m.notice: agent prose sends as m.notice so
      // .m.rule.suppress_notices silences the chunk storm server-side
      // (ZNC025 §10) — a thread root sent by an agent must still surface here.
      if (
        (ev.content?.msgtype !== 'm.text' && ev.content?.msgtype !== 'm.notice') ||
        typeof ev.content.body !== 'string'
      )
        continue
      const relatesTo = ev.content['m.relates_to']
      if (relatesTo?.rel_type === 'm.thread') continue // skip thread replies
      const agent = this.opts.agentBots.get(ev.sender)
      const bundled = ev.unsigned?.['m.relations']?.['m.thread']
      const replyCount = bundled?.count ?? 0
      const latestTs = bundled?.latest_event?.origin_server_ts ?? ev.origin_server_ts
      threads.push({
        id: ev.event_id,
        sender: ev.sender,
        text: ev.content.body,
        timestamp: new Date(ev.origin_server_ts).toISOString(),
        is_agent: agent !== undefined,
        ...(agent !== undefined ? { agent_name: agent } : {}),
        reply_count: replyCount,
        last_activity_at: new Date(latestTs).toISOString(),
      })
    }
    return {
      threads,
      next_before: end,
      has_more: end !== undefined,
    }
  }

  async getThreadHistory(
    channelId: string,
    threadId: string,
    hopts: HistoryOptions,
  ): Promise<HistoryPage> {
    // Root event first (only on the first page when no pagination cursor).
    const messages: Message[] = []
    if (!hopts.before) {
      const root = (await this.opts.client.fetchEvent(
        channelId,
        threadId,
        this.opts.asUserId,
      )) as unknown as MatrixMessageEvent | null
      if (root) {
        const rootMsg = this.toMessage(root)
        if (rootMsg) messages.push({ ...rootMsg, thread_id: threadId })
      }
    }
    const { chunk, next_batch } = await this.opts.client.fetchThreadRelations({
      roomId: channelId,
      rootEventId: threadId,
      asUserId: this.opts.asUserId,
      limit: hopts.limit,
      from: hopts.before,
    })
    for (const ev of chunk as unknown as MatrixMessageEvent[]) {
      const reply = this.toMessage(ev)
      if (reply) messages.push({ ...reply, thread_id: threadId })
    }
    return {
      messages,
      next_before: next_batch,
      has_more: next_batch !== undefined,
    }
  }

  private toMessage(ev: MatrixMessageEvent): Message | null {
    if (ev.type !== 'm.room.message') return null
    const msgtype = ev.content?.msgtype
    const body = ev.content?.body
    const agent = this.opts.agentBots.get(ev.sender)
    const relatesTo = ev.content?.['m.relates_to']
    const threadId =
      relatesTo?.rel_type === 'm.thread' && relatesTo.event_id ? relatesTo.event_id : undefined

    // Media events render as context placeholders
    if (msgtype === 'm.image' || msgtype === 'm.file' || msgtype === 'm.video' || msgtype === 'm.audio') {
      const kind = msgtype.slice(2) // 'image', 'file', 'video', 'audio'
      const name = typeof body === 'string' && body ? body : 'untitled'
      return {
        id: ev.event_id,
        sender: ev.sender,
        text: `[${kind}: ${name}]`,
        timestamp: new Date(ev.origin_server_ts).toISOString(),
        is_agent: agent !== undefined,
        ...(agent !== undefined ? { agent_name: agent } : {}),
        ...(threadId !== undefined ? { thread_id: threadId } : {}),
      }
    }

    // Agent prose sends as m.notice (ZNC025 §10); m.text is human prose.
    if ((msgtype !== 'm.text' && msgtype !== 'm.notice') || typeof body !== 'string') return null
    return {
      id: ev.event_id,
      sender: ev.sender,
      text: body,
      timestamp: new Date(ev.origin_server_ts).toISOString(),
      is_agent: agent !== undefined,
      ...(agent !== undefined ? { agent_name: agent } : {}),
      ...(threadId !== undefined ? { thread_id: threadId } : {}),
    }
  }

  async getChannelMembers(channelId: string): Promise<Member[]> {
    const { joined } = await this.opts.client.getJoinedMembers(channelId, this.opts.asUserId)
    return Object.entries(joined).map(([id, info]) => {
      const agent = this.opts.agentBots.get(id)
      return {
        id,
        name: info.display_name ?? id,
        is_agent: agent !== undefined,
        ...(agent !== undefined ? { agent_name: agent } : {}),
      }
    })
  }

  async getRoomInfo(channelId: string): Promise<RoomInfo> {
    const name = await this.opts.client.fetchRoomName(channelId, this.opts.asUserId)
    return {
      id: channelId,
      name: name ?? channelId,
      transport: 'matrix',
    }
  }

  async getRooms(): Promise<RoomInfo[]> {
    const rooms = this.opts.rooms ?? []
    return Promise.all(
      rooms.map(async (r) => {
        const name = await this.opts.client.fetchRoomName(r.alias, this.opts.asUserId)
        return { id: r.alias, name: name ?? r.alias, transport: 'matrix' as const }
      }),
    )
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const roomId = await this.resolveRoom(input.room)
    if (!roomId) {
      throw new Error(`not_in_room: this agent is not a member of ${input.room}`)
    }

    const content = { msgtype: 'm.notice', body: input.text }
    const post = (threadRoot?: string) =>
      this.opts.client.sendMessage({
        roomId,
        asUserId: this.opts.asUserId,
        // m.notice, not m.text: agent prose sends as m.notice so
        // .m.rule.suppress_notices silences it server-side (ZNC025 §10).
        content,
        ...(threadRoot ? { threadRoot } : {}),
      })

    const threadRoot = input.thread_id
    if (!threadRoot) {
      const { event_id } = await post()
      return { event_id }
    }

    // A thread root lives in exactly one room; relating a message in a
    // different room to it is a hard 400. When the root is provably elsewhere,
    // drop the relation and post top-level so a stale/cross-room thread_id
    // degrades to a usable message instead of a bare homeserver error.
    const verdict = await this.threadRootVerdict(roomId, threadRoot)
    if (verdict === 'out') {
      const { event_id } = await post()
      return { event_id, warning: topLevelFallback(threadRoot, roomId) }
    }

    if (verdict === 'unknown') {
      // The probe failed, so we can't prove the mismatch up front. Attempt the
      // relation and let the homeserver arbitrate; on a room-grounds rejection,
      // remember the miss and retry top-level.
      try {
        const { event_id } = await post(threadRoot)
        this.threadRooms.set(threadRoot, roomId)
        return { event_id, thread_id: threadRoot }
      } catch (err) {
        if (!isRelationRoomMismatch(err)) throw err
        this.threadRoomMisses.add(missKey(roomId, threadRoot))
        const { event_id } = await post()
        return { event_id, warning: topLevelFallback(threadRoot, roomId) }
      }
    }

    const { event_id } = await post(threadRoot)
    this.threadRooms.set(threadRoot, roomId)
    return { event_id, thread_id: threadRoot }
  }

  /**
   * Resolve a caller-supplied room reference to a canonical room ID this agent
   * is bound to. Accepts the room ID, its alias (`#review` /
   * `#review:server`), or its display name (`review`) — the values an agent
   * sees in `getRooms()`. Anything not bound to this agent resolves to
   * `undefined`, preserving the membership check as the authorization gate.
   * A directory/room-name lookup failure propagates (it is not a membership
   * verdict), and an ambiguous display name throws rather than guessing.
   */
  private async resolveRoom(input: string): Promise<string | undefined> {
    const rooms = this.opts.rooms ?? []
    const direct = rooms.find((r) => r.alias === input)
    if (direct) return direct.alias
    if (rooms.length === 0) return undefined
    // Room IDs have no alias or display name to match.
    if (input.startsWith('!')) return undefined

    const bare = input.replace(/^#/, '')
    const localpart = bare.split(':')[0]
    if (!localpart) return undefined
    // Alias form: try the caller's server (if given) and this agent's own
    // homeserver, then re-check the resolved id against bound rooms. A
    // `resolveAlias` throw (401/403/5xx) is a real directory failure and must
    // surface as such — only `null` (404) means "no such alias".
    const server = this.opts.asUserId.split(':').slice(1).join(':')
    const aliases = new Set<string>([`#${localpart}:${server}`])
    if (bare.includes(':')) aliases.add(`#${bare}`)
    for (const alias of aliases) {
      const resolved = await this.opts.client.resolveAlias(alias)
      const bound = resolved ? rooms.find((r) => r.alias === resolved) : undefined
      if (bound) return bound.alias
    }

    // Display-name form (the `name` in getRooms()), matched case-insensitively
    // on the localpart (so `#handoffs:server` matches a room named "handoffs"
    // even without a directory alias). Ambiguity is a refusal, not a guess.
    const target = localpart.toLowerCase()
    const matches: string[] = []
    for (const r of rooms) {
      const name = await this.opts.client.fetchRoomName(r.alias, this.opts.asUserId)
      if (name?.toLowerCase() === target) matches.push(r.alias)
    }
    if (matches.length > 1) {
      throw new Error(
        `ambiguous_room: "${input}" matches ${matches.length} bound rooms ` +
          `(${matches.join(', ')}); pass a room id instead`,
      )
    }
    return matches[0]
  }

  /**
   * Whether `rootId` is an event in `roomId`. Memoizes both verdicts — an event
   * id is immutable, so a positive hit or a miss in a given room is permanent.
   * `'unknown'` means the probe itself failed; the caller then lets the
   * homeserver arbitrate rather than guessing.
   */
  private async threadRootVerdict(
    roomId: string,
    rootId: string,
  ): Promise<'in' | 'out' | 'unknown'> {
    const known = this.threadRooms.get(rootId)
    if (known !== undefined) return known === roomId ? 'in' : 'out'
    if (this.threadRoomMisses.has(missKey(roomId, rootId))) return 'out'
    try {
      const root = await this.opts.client.fetchEvent(roomId, rootId, this.opts.asUserId)
      if (root) {
        this.threadRooms.set(rootId, roomId)
        return 'in'
      }
      this.threadRoomMisses.add(missKey(roomId, rootId))
      return 'out'
    } catch {
      return 'unknown'
    }
  }
}

function missKey(roomId: string, rootId: string): string {
  return `${roomId}\u0000${rootId}`
}
