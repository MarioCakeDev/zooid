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
}

export async function fireTrigger(deps: FireTriggerDeps): Promise<void> {
  const { name, as, message, agentUserIds, resolveRoom, ensureBot, sendMessage } = deps
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
  } catch (err) {
    // Never throw: one bad firing must not take down the scheduler.
    console.warn(`[trigger:${name}] failed:`, (err as Error).message)
  }
}
