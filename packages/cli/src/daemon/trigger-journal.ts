import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PersistedTriggerGuard, TriggerJournal } from '@zooid/transport-matrix'

/**
 * Durable, small mention-trigger dedupe state stored alongside daemon state.
 * Written after every allowed dispatch so a restart cannot replay the same
 * event into a fresh turn.
 */
export function makeTriggerJournal(dataDir: string): TriggerJournal {
  const path = join(dataDir, 'triggers.json')
  return {
    load() {
      try {
        const value = JSON.parse(readFileSync(path, 'utf8')) as PersistedTriggerGuard
        return value.version === 1 && Array.isArray(value.entries) ? value : undefined
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn('[triggers] journal unavailable; starting empty:', error)
        }
        return undefined
      }
    },
    save(state) {
      mkdirSync(dataDir, { recursive: true })
      const temp = `${path}.tmp-${process.pid}`
      try {
        writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8')
        renameSync(temp, path)
      } catch (error) {
        console.warn('[triggers] journal write failed:', error)
        try {
          unlinkSync(temp)
        } catch {}
      }
    },
  }
}
