import type { TriggerMessage } from '@zooid/core'
import { buildMentionContent } from '@zooid/transport-matrix'

export interface FireTriggerDeps {
  name: string
  as: string
  message: TriggerMessage
  /** Local agent name → MXID. A `mention:` that is already an MXID bypasses this. */
  agentUserIds: Record<string, string>
  resolveRoom: (room: string) => Promise<string | null>
  ensureBot: (asUserId: string, roomId: string) => Promise<void>
  sendMessage: (input: {
    roomId: string
    asUserId: string
    content: { msgtype: string; body: string; [k: string]: unknown }
  }) => Promise<{ event_id: string }>
  /**
   * Optional: enables the [[ZOD081]] §Design 6 "nobody is listening" warning.
   * Omitted in tests that don't care about it — the check is then skipped
   * silently, never a hard requirement to fire.
   */
  getJoinedMembers?: (roomId: string, asUserId: string) => Promise<{ joined: Record<string, unknown> }>
}

// Module-level so a daily trigger against an off laptop logs once per daemon
// run, not once a day. Keyed by trigger name + target so distinct triggers
// (or targets) each get their own first warning.
const warnedTargets = new Set<string>()

export async function fireTrigger(deps: FireTriggerDeps): Promise<void> {
  const { name, as, message, agentUserIds, resolveRoom, ensureBot, sendMessage, getJoinedMembers } = deps
  try {
    const target = message.mention.startsWith('@')
      ? message.mention
      : agentUserIds[message.mention]
    if (!target) {
      console.warn(`[trigger:${name}] unknown agent "${message.mention}" — skipping`)
      return
    }
    const roomId = await resolveRoom(message.room)
    if (!roomId) {
      console.warn(`[trigger:${name}] cannot resolve room ${message.room} — skipping`)
      return
    }
    await ensureBot(as, roomId)
    await sendMessage({
      roomId,
      asUserId: as,
      content: {
        ...buildMentionContent({ userId: target, text: message.text, msgtype: 'm.text' }),
        'dev.zooid.trigger': {
          name,
          fired_at: Date.now(),
          ...(message.ttlMs !== undefined ? { ttl_ms: message.ttlMs } : {}),
        },
      },
    })

    // Post first, warn second: an absent target isn't a lost message —
    // catch-up may still deliver it if that agent joins before it expires.
    // Membership, not registration: router.ts routes only to agents joined
    // to the room, so an agent that exists but isn't in the room misses the
    // firing exactly as an unregistered one does.
    if (getJoinedMembers) {
      const { joined } = await getJoinedMembers(roomId, as)
      const key = `${name}|${target}`
      if (!(target in joined) && !warnedTargets.has(key)) {
        warnedTargets.add(key)
        console.warn(
          `[trigger:${name}] ${target} is not in ${message.room} — nothing will handle this ` +
            `unless that agent joins before the message expires`,
        )
      }
    }
  } catch (err) {
    // Never throw: one bad firing must not take down the scheduler.
    console.warn(`[trigger:${name}] failed:`, (err as Error).message)
  }
}
