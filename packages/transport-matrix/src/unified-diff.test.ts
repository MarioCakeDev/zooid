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
    expect(diff.length).toBeLessThan(DIFF_MAX + 40)
    const last = diff.split('\n').at(-1)!
    expect(last).toMatch(/^… \+\d+ more diff lines$/)
  })

  it('never leaves a @@ header above a hunk body it cut short', () => {
    const old = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n')
    const next = Array.from({ length: 400 }, (_, i) => `LINE ${i}`).join('\n')
    const lines = unifiedDiff('big.txt', old, next)!.split('\n')
    expect(lines.at(-1)).toMatch(/^… \+\d+ more diff lines$/)
    // The single hunk straddles the budget, so its header goes with the lines
    // it no longer describes.
    expect(lines.filter((l) => l.startsWith('@@'))).toHaveLength(0)
    expect(lines.slice(0, 2)).toEqual(['--- a/big.txt', '+++ b/big.txt'])
  })

  it('keeps whole hunks only, dropping later ones past the budget', () => {
    // ~40 hunks of ~50-char lines, so the budget lands mid-way through them.
    const old = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n')
    const next = Array.from({ length: 2000 }, (_, i) => `LINE ${i}`).join('\n')
    const lines = unifiedDiff('big.txt', old, next)!.split('\n')
    const kept = lines.slice(0, lines.length - 1)
    // Every kept `@@` header is followed by a full CONTEXT-bounded body, and
    // the whole render stays near the budget.
    expect(kept.join('\n').length).toBeLessThanOrEqual(DIFF_MAX + 40)
    for (const hunk of kept.slice(2).join('\n').split(/(?=^@@ )/m)) {
      if (!hunk.startsWith('@@')) continue
      const body = hunk.split('\n').length - 1
      expect(body).toBeGreaterThan(0)
    }
  })


  it('separates a headerless excerpt from the whole hunk kept above it', () => {
    // Hunk A is small enough to be kept whole; hunk B is large enough to
    // straddle the budget. Its `@@` header is cut with the lines it no longer
    // describes, so its body needs an explicit boundary or it reads as more of
    // hunk A — whose header does not cover it.
    const old = ['A base', ...Array.from({ length: 20 }, (_, i) => `filler ${i}`)]
    const next = ['A CHANGED', ...old.slice(1)]
    for (let i = 0; i < 80; i++) {
      old.push(`bulk ${i}`)
      next.push(`bulk ${i} CHANGED ${'z'.repeat(30)}`)
    }
    const lines = unifiedDiff('f.txt', old.join('\n'), next.join('\n'))!.split('\n')
    const at = lines.findIndex((l) => l.includes('excerpt of the next hunk'))
    expect(at).toBeGreaterThan(0)
    // The kept hunk's body is intact, and the excerpt sits below the separator.
    expect(lines[2]).toMatch(/^@@ /)
    expect(lines.slice(3, at).every((l) => !l.startsWith('@@'))).toBe(true)
    expect(lines.at(-1)).toMatch(/^… \+\d+ more diff lines$/)
  })

  it('falls back to a coarse whole-block diff instead of hanging on huge input', () => {
    const old = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n')
    const next = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n')
    const diff = unifiedDiff('big.txt', old, next)!
    // Every line is either removed or added — no context survives, and the one
    // hunk is over budget, so it is shown as a headerless excerpt plus a marker.
    const body = diff.split('\n').slice(2)
    expect(body.some((l) => l.startsWith(' a0'))).toBe(false)
    expect(body).toContain('-a0')
    // Coarse emits every deletion before every addition, so the budget lands
    // inside the removal block; the marker accounts for the rest.
    expect(body.at(-1)).toMatch(/^… \+\d{3,} more diff lines$/)
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

  it('keys the create fallback on the write title, not the edit kind', () => {
    // opencode reports its `write` tool with ACP kind "edit" (ACP has no write
    // kind). The title is what identifies the whole-file create.
    const diff = toolCallDiff({
      title: 'Write /tmp/x',
      kind: 'edit',
      raw_input: { filePath: '/tmp/x', content: 'x\n' },
    })!
    expect(diff).toContain('--- /dev/null')
    expect(diff).toContain('+x')
  })

  it('does not invent a diff for a non-writing tool with a content key', () => {
    expect(
      toolCallDiff({ title: 'fetch', raw_input: { path: '/api', content: 'body' } }),
    ).toBeUndefined()
  })

  it('claims /dev/null only for a tool that creates a file', () => {
    expect(
      toolCallDiff({ title: 'create f.ts', raw_input: { path: 'f.ts', content: 'x' } }),
    ).toContain('--- /dev/null')
    // An in-place tool with no old text has nothing honest to say about the
    // file's prior existence, so it gets no diff rather than a false creation.
    for (const title of ['edit', 'update', 'patch', 'apply', 'multiedit', 'apply_patch']) {
      expect(toolCallDiff({ title, raw_input: { path: 'f.ts', content: 'x\n' } })).toBeUndefined()
    }
  })

  it('still diffs an in-place tool that carries the real old text', () => {
    const diff = toolCallDiff({
      title: 'edit f.ts',
      raw_input: { path: 'f.ts', old_string: 'a\n', new_string: 'b\n' },
    })!
    expect(diff).toContain('--- a/f.ts')
    expect(diff).toContain('-a')
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
