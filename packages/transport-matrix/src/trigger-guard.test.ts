import { describe, it, expect } from 'vitest'
import {
  TriggerGuard,
  type PersistedTriggerGuard,
  type TriggerJournal,
} from './trigger-guard.js'

function memoryJournal(store: { state?: PersistedTriggerGuard }): TriggerJournal {
  return {
    load: () => store.state,
    save: (state) => {
      store.state = JSON.parse(JSON.stringify(state)) as PersistedTriggerGuard
    },
  }
}

describe('TriggerGuard', () => {
  it('allows the first dispatch and suppresses the same (event, target) within the window', () => {
    let now = 1_000
    const guard = new TriggerGuard({ now: () => now, dedupeMs: 60_000 })
    expect(guard.allow('$e1', 'dev')).toEqual({ allowed: true })
    now += 10_000
    expect(guard.allow('$e1', 'dev')).toEqual({ allowed: false, reason: 'duplicate' })
  })

  it('allows a different event for the same target', () => {
    let now = 1_000
    const guard = new TriggerGuard({ now: () => now, dedupeMs: 60_000, maxPerWindow: 10 })
    expect(guard.allow('$e1', 'dev')).toEqual({ allowed: true })
    now += 100
    expect(guard.allow('$e2', 'dev')).toEqual({ allowed: true })
  })

  it('allows the same event for a different target', () => {
    let now = 1_000
    const guard = new TriggerGuard({ now: () => now, dedupeMs: 60_000, maxPerWindow: 10 })
    expect(guard.allow('$e1', 'dev')).toEqual({ allowed: true })
    expect(guard.allow('$e1', 'infra')).toEqual({ allowed: true })
  })

  it('re-allows the same event once the dedupe window has passed', () => {
    let now = 1_000
    const guard = new TriggerGuard({ now: () => now, dedupeMs: 30_000, maxPerWindow: 10 })
    expect(guard.allow('$e1', 'dev')).toEqual({ allowed: true })
    now += 30_001
    expect(guard.allow('$e1', 'dev')).toEqual({ allowed: true })
  })

  it('caps a target once the hard per-window limit is reached', () => {
    let now = 1_000
    const guard = new TriggerGuard({
      now: () => now,
      dedupeMs: 1,
      rateWindowMs: 60_000,
      maxPerWindow: 3,
    })
    expect(guard.allow('$a', 'dev').allowed).toBe(true)
    expect(guard.allow('$b', 'dev').allowed).toBe(true)
    expect(guard.allow('$c', 'dev').allowed).toBe(true)
    expect(guard.allow('$d', 'dev')).toEqual({ allowed: false, reason: 'rate_limited' })
    // A different target is unaffected by another target's cap.
    expect(guard.allow('$d', 'infra').allowed).toBe(true)
    // The window rolls: after it passes, dispatch is allowed again.
    now += 60_001
    expect(guard.allow('$d', 'dev').allowed).toBe(true)
  })

  it('is idempotent across a restart via the journal', () => {
    let now = 5_000
    const store: { state?: PersistedTriggerGuard } = {}
    const journal = memoryJournal(store)
    const first = new TriggerGuard({ now: () => now, dedupeMs: 60_000, journal })
    expect(first.allow('$e1', 'dev')).toEqual({ allowed: true })

    // New process, same journal: the event must not dispatch again.
    const second = new TriggerGuard({ now: () => now, dedupeMs: 60_000, journal })
    expect(second.allow('$e1', 'dev')).toEqual({ allowed: false, reason: 'duplicate' })
    // A fresh event still dispatches after the restart.
    expect(second.allow('$e2', 'dev')).toEqual({ allowed: true })
  })

  it('drops journaled entries older than the dedupe window on load', () => {
    let now = 1_000
    const store: { state?: PersistedTriggerGuard } = {}
    const journal = memoryJournal(store)
    const first = new TriggerGuard({ now: () => now, dedupeMs: 10_000, journal })
    expect(first.allow('$e1', 'dev')).toEqual({ allowed: true })

    now += 20_000
    const second = new TriggerGuard({ now: () => now, dedupeMs: 10_000, journal })
    expect(second.allow('$e1', 'dev')).toEqual({ allowed: true })
  })

  it('still rate-limits an event-less dispatch', () => {
    const guard = new TriggerGuard({ now: () => 0, rateWindowMs: 60_000, maxPerWindow: 1 })
    expect(guard.allow(undefined, 'dev').allowed).toBe(true)
    expect(guard.allow(undefined, 'dev')).toEqual({ allowed: false, reason: 'rate_limited' })
  })
})
