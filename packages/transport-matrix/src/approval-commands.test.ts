import { describe, it, expect } from 'vitest'
import {
  decisionForCommand,
  isApprovalId,
  parseApprovalCommand,
  reactionCommand,
  APPROVE_REACTION,
  DENY_REACTION,
} from './approval-commands.js'

const options = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
]

describe('parseApprovalCommand', () => {
  it('parses an explicit approve/deny with an id', () => {
    expect(parseApprovalCommand('approve abc-123')).toEqual({ command: 'approve', approvalId: 'abc-123' })
    expect(parseApprovalCommand('deny abc-123')).toEqual({ command: 'deny', approvalId: 'abc-123' })
  })

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(parseApprovalCommand('  APPROVE  abc  ')).toEqual({ command: 'approve', approvalId: 'abc' })
    expect(parseApprovalCommand('Deny')).toEqual({ command: 'deny', approvalId: undefined })
  })

  it('parses the bare form', () => {
    expect(parseApprovalCommand('approve')).toEqual({ command: 'approve', approvalId: undefined })
  })

  it('does not match ordinary prose', () => {
    expect(parseApprovalCommand('please approve the plan')).toBeNull()
    expect(parseApprovalCommand('I deny everything')).toBeNull()
    expect(parseApprovalCommand('approved')).toBeNull()
    expect(parseApprovalCommand('')).toBeNull()
    // Trailing prose after an id is not a command.
    expect(parseApprovalCommand('approve abc because reasons')).toBeNull()
  })
})

describe('isApprovalId', () => {
  it('accepts a UUID (the shape ApprovalCorrelator mints)', () => {
    expect(isApprovalId('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true)
  })

  it('rejects prose and non-UUID tokens', () => {
    expect(isApprovalId('please')).toBe(false)
    expect(isApprovalId('a1')).toBe(false)
    expect(isApprovalId(undefined)).toBe(false)
  })
})

describe('reactionCommand', () => {
  it('maps the canonical thumbs reactions to a decision', () => {
    expect(reactionCommand(APPROVE_REACTION)).toBe('approve')
    expect(reactionCommand(DENY_REACTION)).toBe('deny')
    expect(reactionCommand('👍')).toBe('approve')
    expect(reactionCommand('👎')).toBe('deny')
  })

  it('resolves the VS16 forms Element and mobile clients send', () => {
    // Element appends U+FE0F; the observed deny key was f0 9f 91 8e ef b8 8f.
    expect(reactionCommand('\u{1F44D}\u{FE0F}')).toBe('approve')
    expect(reactionCommand('\u{1F44E}\u{FE0F}')).toBe('deny')
    // VS15 (text presentation) and a ZWJ are equally presentation-only.
    expect(reactionCommand('\u{1F44D}\u{FE0E}')).toBe('approve')
    expect(reactionCommand('\u{1F44E}\u{200D}')).toBe('deny')
  })

  it('resolves skin-tone variants', () => {
    expect(reactionCommand('\u{1F44D}\u{1F3FD}')).toBe('approve')
    expect(reactionCommand('\u{1F44E}\u{1F3FF}')).toBe('deny')
    expect(reactionCommand('\u{1F44D}\u{1F3FB}\u{FE0F}')).toBe('approve')
  })

  it('matches the exact bytes Element sent for the deny reaction', () => {
    const observed = Buffer.from('f09f918eefb88f', 'hex').toString('utf8')
    expect(observed).toBe('\u{1F44E}\u{FE0F}')
    expect(reactionCommand(observed)).toBe('deny')
  })

  it('ignores any other reaction key, including the retired ✅/❌', () => {
    expect(reactionCommand('✅')).toBeUndefined()
    expect(reactionCommand('❌')).toBeUndefined()
    expect(reactionCommand('✅\u{FE0F}')).toBeUndefined()
    expect(reactionCommand('yes')).toBeUndefined()
    expect(reactionCommand(undefined)).toBeUndefined()
    expect(reactionCommand(null)).toBeUndefined()
    expect(reactionCommand(42)).toBeUndefined()
  })
})

describe('decisionForCommand', () => {
  it('approve prefers allow_once over allow_always regardless of option order', () => {
    expect(decisionForCommand('approve', options)).toEqual({
      ok: true,
      decision: { decision: 'allow', optionId: 'allow-once' },
    })
    // Agent lists the persistent option first — still pick the narrow one.
    expect(
      decisionForCommand('approve', [
        { optionId: 'allow-always', name: 'Always', kind: 'allow_always' },
        { optionId: 'allow-once', name: 'Once', kind: 'allow_once' },
      ]),
    ).toEqual({ ok: true, decision: { decision: 'allow', optionId: 'allow-once' } })
  })

  it('deny prefers reject_once over reject_always regardless of option order', () => {
    expect(decisionForCommand('deny', options)).toEqual({
      ok: true,
      decision: { decision: 'allow', optionId: 'reject-once' },
    })
    expect(
      decisionForCommand('deny', [
        { optionId: 'reject-always', name: 'Always', kind: 'reject_always' },
        { optionId: 'reject-once', name: 'Once', kind: 'reject_once' },
      ]),
    ).toEqual({ ok: true, decision: { decision: 'allow', optionId: 'reject-once' } })
  })

  it('approve falls back to the sole option when it has no allow kind', () => {
    expect(decisionForCommand('approve', [{ optionId: 'ok', name: 'OK', kind: 'confirm' }])).toEqual({
      ok: true,
      decision: { decision: 'allow', optionId: 'ok' },
    })
  })

  it('approve errors when there is no allow option and more than one choice', () => {
    const r = decisionForCommand('approve', [
      { optionId: 'a', name: 'A', kind: 'custom' },
      { optionId: 'b', name: 'B', kind: 'custom' },
    ])
    expect(r.ok).toBe(false)
  })

  it('deny cancels when the request exposes no reject option', () => {
    expect(decisionForCommand('deny', [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }])).toEqual({
      ok: true,
      decision: { decision: 'cancel' },
    })
  })

  it('tolerates a missing options array', () => {
    expect(decisionForCommand('deny', undefined as never)).toEqual({
      ok: true,
      decision: { decision: 'cancel' },
    })
  })
})
