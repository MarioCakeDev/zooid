import { describe, expect, it } from 'vitest'
import { MAX_OPEN_TASKS_PER_ROOM, TaskRegistry } from './task-registry.js'

const parent = {
  agent: 'supervisor',
  threadRoot: '$parent',
  sessionKey: '$parent',
  generation: 0,
}
const reserve = (r: TaskRegistry, roomId = '!room:hs') =>
  r.reserve({ roomId, assignee: 'worker', notify: 'caller', parent })

describe('TaskRegistry', () => {
  it('enforces the open-task cap independently per room and releases once', () => {
    const r = new TaskRegistry({
      newId: (() => {
        let i = 0
        return () => `t${++i}`
      })(),
    })
    for (let i = 0; i < MAX_OPEN_TASKS_PER_ROOM; i++) expect(reserve(r)).toBeDefined()
    expect(reserve(r)).toBeUndefined()
    const task = r.taskForRoot('$root')
    expect(task).toBeUndefined()
    r.activate('t1', '$root')
    expect(r.close('t1')).toBe(true)
    expect(r.close('t1')).toBe(false)
    expect(reserve(r)).toBeDefined()
    expect(reserve(r, '!other:hs')).toBeDefined()
  })
  it('adopts only issued attempts, retains closed roots, and protects uncertain sends', () => {
    const r = new TaskRegistry({ maxOpenPerRoom: 1, newId: () => 'attempt' })
    const task = reserve(r)!
    r.markUncertain(task.taskId)
    expect(reserve(r)).toBeUndefined()
    expect(r.adopt('forged', '$bad')).toBeUndefined()
    expect(r.adopt(task.attemptId, '$root')?.phase).toBe('open')
    expect(r.openTaskFor('worker', '$root')?.taskId).toBe(task.taskId)
    expect(r.recordSummary(task.taskId, 'first')).toBe('recorded')
    expect(r.recordSummary(task.taskId, 'second')).toBe('already_recorded')
    r.close(task.taskId)
    expect(r.taskForRoot('$root')?.phase).toBe('closed')
  })
  it('bumps session generations after a reset', () => {
    const r = new TaskRegistry()
    expect(r.generationOf('a', '$s')).toBe(0)
    r.bumpGeneration('a', '$s')
    expect(r.generationOf('a', '$s')).toBe(1)
  })
  it('captures the caller generation in the task thread at activation', () => {
    const r = new TaskRegistry({ newId: () => 'attempt' })
    const task = reserve(r)!
    r.activate(task.taskId, '$task-thread')
    expect(task.parent.taskThreadGeneration).toBe(0)
    // A later /clear of the task thread moves the live generation; the captured
    // value stays put so the completion wake can detect the reset.
    r.bumpGeneration('supervisor', '$task-thread')
    expect(r.generationOf('supervisor', '$task-thread')).toBe(1)
    expect(task.parent.taskThreadGeneration).toBe(0)
  })
})
