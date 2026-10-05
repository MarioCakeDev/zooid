import { describe, it, expect } from 'vitest'
import {
  contentFromAnswer,
  isElicitationRequestId,
  parseElicitationCommand,
  reactionIndex,
} from './elicitation-commands.js'

const singleEnum = {
  type: 'object' as const,
  properties: { env: { type: 'string' as const, enum: ['staging', 'prod'] } },
  required: ['env'],
}
const oneOfEnum = {
  type: 'object' as const,
  properties: { q: { type: 'string' as const, oneOf: [{ const: 'a' }, { const: 'b' }] } },
  required: ['q'],
}
const multi = {
  type: 'object' as const,
  properties: { a: { type: 'string' as const }, b: { type: 'number' as const } },
  required: ['a'],
}

describe('parseElicitationCommand', () => {
  it('parses answer/decline/cancel with an explicit request id', () => {
    expect(parseElicitationCommand('answer 3f2504e0-4f89-41d3-9a0c-0305e82c3301 prod')).toEqual({
      action: 'answer',
      requestId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      value: 'prod',
    })
    expect(parseElicitationCommand('decline 3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toEqual({
      action: 'decline',
      requestId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    })
    expect(parseElicitationCommand('cancel 3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toEqual({
      action: 'cancel',
      requestId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    })
  })

  it('is case-insensitive and keeps multi-word / JSON values verbatim', () => {
    expect(parseElicitationCommand('  ANSWER abc a longer free text answer  ')).toEqual({
      action: 'answer',
      requestId: 'abc',
      value: 'a longer free text answer',
    })
    expect(parseElicitationCommand('answer abc {"a":"x","b":2}')).toEqual({
      action: 'answer',
      requestId: 'abc',
      value: '{"a":"x","b":2}',
    })
    expect(parseElicitationCommand('Decline Abc')).toEqual({ action: 'decline', requestId: 'Abc' })
  })

  it('does not match ordinary prose', () => {
    expect(parseElicitationCommand('answers')).toBeNull()
    expect(parseElicitationCommand('decline')).toBeNull()
    expect(parseElicitationCommand('please answer 42')).toBeNull()
    expect(parseElicitationCommand('')).toBeNull()
  })

  it('is command-shaped for prose like "answer the question", so the transport gates on the id shape', () => {
    const parsed = parseElicitationCommand('answer the question please')
    expect(parsed).not.toBeNull()
    // Not a UUID, so the transport treats the message as ordinary prose.
    expect(isElicitationRequestId(parsed!.requestId)).toBe(false)
  })
})

describe('isElicitationRequestId', () => {
  it('accepts the UUID shape the correlator mints', () => {
    expect(isElicitationRequestId('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true)
  })
  it('rejects prose and short tokens', () => {
    expect(isElicitationRequestId('please')).toBe(false)
    expect(isElicitationRequestId(undefined)).toBe(false)
  })
})

describe('contentFromAnswer', () => {
  it('maps a bare value to the sole string field', () => {
    expect(contentFromAnswer(singleEnum, 'prod')).toEqual({ ok: true, content: { env: 'prod' } })
    expect(contentFromAnswer(oneOfEnum, 'b')).toEqual({ ok: true, content: { q: 'b' } })
  })

  it('coerces number and boolean bare values for the sole field', () => {
    const num = { type: 'object' as const, properties: { n: { type: 'number' as const } }, required: ['n'] }
    expect(contentFromAnswer(num, '5')).toEqual({ ok: true, content: { n: 5 } })
    const bool = { type: 'object' as const, properties: { b: { type: 'boolean' as const } }, required: ['b'] }
    expect(contentFromAnswer(bool, 'true')).toEqual({ ok: true, content: { b: true } })
  })

  it('splits a comma list for a sole multi-select field', () => {
    const arr = {
      type: 'object' as const,
      properties: { pick: { type: 'array' as const, items: { anyOf: [{ const: 'x' }, { const: 'y' }] } } },
      required: ['pick'],
    }
    expect(contentFromAnswer(arr, 'x, y')).toEqual({ ok: true, content: { pick: ['x', 'y'] } })
  })

  it('accepts a JSON object for a multi-field form', () => {
    expect(contentFromAnswer(multi, '{"a":"hello","b":2}')).toEqual({
      ok: true,
      content: { a: 'hello', b: 2 },
    })
  })

  it('refuses a bare value for a multi-field form', () => {
    const r = contentFromAnswer(multi, 'hello')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/multiple fields/)
  })

  it('refuses malformed or non-object JSON', () => {
    expect(contentFromAnswer(multi, '{not json')).toMatchObject({ ok: false })
    expect(contentFromAnswer(multi, '[1,2]')).toMatchObject({ ok: false })
  })
})

describe('reactionIndex', () => {
  it('maps the canonical keycap emojis to a 0-based index', () => {
    expect(reactionIndex('1️⃣')).toBe(0)
    expect(reactionIndex('2️⃣')).toBe(1)
    expect(reactionIndex('9️⃣')).toBe(8)
  })

  it('tolerates a missing variation selector', () => {
    expect(reactionIndex('1\u20E3')).toBe(0)
    expect(reactionIndex('\u0031\uFE0F\u20E3')).toBe(0)
  })

  it('ignores non-number reactions', () => {
    expect(reactionIndex('👍')).toBeUndefined()
    expect(reactionIndex('0️⃣')).toBeUndefined()
    expect(reactionIndex('🔟')).toBeUndefined()
    expect(reactionIndex(undefined)).toBeUndefined()
  })
})
