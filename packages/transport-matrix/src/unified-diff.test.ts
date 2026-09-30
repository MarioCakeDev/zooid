import { describe, it, expect } from 'vitest'
import { unifiedDiff, toolCallDiff, DIFF_MAX } from './unified-diff.js'

describe('unifiedDiff', () => {
  it('renders headers and one hunk for a single-line change', () => {
    expect(unifiedDiff('src/x.ts', 'const a = 1\n', 'const a = 2\n')).toBe(
      [
        '--- a/src/x.ts',
        '+++ b/src/x.ts',
        '@@ -1 +1 @@',
        '-const a = 1',
        '+const a = 2',
      ].join('\n'),
    )
  })

  it('keeps context on both sides of the change', () => {
    const old = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'].join('\n') + '\n'
    const next = old.replace('a5', 'A5')
    const diff = unifiedDiff('f.txt', old, next)!
    expect(diff.split('\n')).toEqual([
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -2,7 +2,7 @@',
      ' a2',
      ' a3',
      ' a4',
      '-a5',
      '+A5',
      ' a6',
      ' a7',
      ' a8',
    ])
  })

  it('splits distant changes into two hunks', () => {
    const old = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n') + '\n'
    const next = old.replace('l3', 'X3').replace('l25', 'X25')
    const diff = unifiedDiff('f.txt', old, next)!
    const hunks = diff.split('\n').filter((l) => l.startsWith('@@'))
    expect(hunks).toHaveLength(2)
    expect(hunks[0]).toMatch(/^@@ -1,7 \+1,7 @@$/)
    expect(hunks[1]).toMatch(/^@@ -23,7 \+23,7 @@$/)
  })

  it('counts a pure addition as an empty old range', () => {
    const diff = unifiedDiff('new.ts', '', 'one\ntwo\n')!
    expect(diff).toBe(
      ['--- a/new.ts', '+++ b/new.ts', '@@ -0,0 +1,2 @@', '+one', '+two'].join('\n'),
    )
  })

  it('uses /dev/null when the file did not exist', () => {
    const diff = unifiedDiff('new.ts', undefined, 'one\n')!
    expect(diff.split('\n')[0]).toBe('--- /dev/null')
    expect(diff).toContain('+++ b/new.ts')
    expect(diff).toContain('@@ -0,0 +1 @@')
  })

  it('shows a whitespace-only change as a real removal and addition', () => {
    const diff = unifiedDiff('f.txt', '  a\n', '    a\n')!
    expect(diff).toContain('-  a')
    expect(diff).toContain('+    a')
  })

  it('returns no diff when old and new are identical', () => {
    expect(unifiedDiff('f.txt', 'same\n', 'same\n')).toBeUndefined()
    expect(unifiedDiff('f.txt', '', '')).toBeUndefined()
    expect(unifiedDiff('f.txt', undefined, '')).toBeUndefined()
  })

  it('truncates a huge diff and says how many lines were dropped', () => {
    const old = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n')
    const next = Array.from({ length: 4000 }, (_, i) => `LINE ${i}`).join('\n')
    const diff = unifiedDiff('big.txt', old, next)!
    expect(diff.length).toBeLessThanOrEqual(DIFF_MAX + 40)
    const last = diff.split('\n').at(-1)!
    expect(last).toMatch(/^… \+\d+ more diff lines$/)
  })

  it('falls back to a coarse whole-block diff instead of hanging on huge input', () => {
    const old = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n')
    const next = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n')
    const diff = unifiedDiff('big.txt', old, next)!
    // Every line is either removed or added, in one hunk.
    const body = diff.split('\n').slice(2)
    expect(body.filter((l) => l.startsWith('@@'))).toHaveLength(1)
    expect(body.some((l) => l.startsWith(' a0'))).toBe(false)
  })
})

describe('toolCallDiff', () => {
  it('diffs an edit from oldString/newString and names the file', () => {
    const diff = toolCallDiff({
      title: 'edit src/x.ts',
      raw_input: { filePath: '/w/src/x.ts', oldString: 'a\nb\n', newString: 'a\nc\n' },
    })!
    expect(diff).toContain('--- a//w/src/x.ts')
    expect(diff).toContain('+++ b//w/src/x.ts')
    expect(diff).toContain('-b')
    expect(diff).toContain('+c')
  })

  it('accepts the snake_case and oldText/newText spellings', () => {
    expect(
      toolCallDiff({ title: 'edit', raw_input: { path: 'f', old_string: 'a', new_string: 'b' } }),
    ).toContain('@@ -1 +1 @@')
    expect(
      toolCallDiff({ title: 'edit', raw_input: { path: 'f', oldText: 'a', newText: 'b' } }),
    ).toContain('@@ -1 +1 @@')
  })

  it('prefers a diff content block over the raw input', () => {
    const diff = toolCallDiff({
      title: 'edit src/x.ts',
      raw_input: { filePath: '/w/src/x.ts', oldString: 'raw old', newString: 'raw new' },
      content: [{ type: 'diff', path: 'src/x.ts', oldText: 'a\n', newText: 'b\n' }],
    })!
    expect(diff).toContain('--- a/src/x.ts')
    expect(diff).toContain('-a')
    expect(diff).toContain('+b')
    expect(diff).not.toContain('raw old')
  })

  it('diffs a whole-file write as pure additions', () => {
    const diff = toolCallDiff({
      title: 'write src/new.ts',
      raw_input: { filePath: 'src/new.ts', content: 'x\ny\n' },
    })!
    expect(diff).toContain('--- /dev/null')
    expect(diff).toContain('+x')
    expect(diff).toContain('+y')
  })

  it('does not invent a diff for a non-writing tool with a content key', () => {
    expect(
      toolCallDiff({ title: 'fetch', raw_input: { path: '/api', content: 'body' } }),
    ).toBeUndefined()
  })

  it('returns no diff for a read, a bash call, or an unchanged edit', () => {
    expect(toolCallDiff({ title: 'read', raw_input: { filePath: 'f' } })).toBeUndefined()
    expect(toolCallDiff({ title: 'bash', raw_input: { command: 'ls' } })).toBeUndefined()
    expect(
      toolCallDiff({ title: 'edit', raw_input: { filePath: 'f', oldString: 'a', newString: 'a' } }),
    ).toBeUndefined()
    expect(toolCallDiff({ title: 'edit' })).toBeUndefined()
  })
})
