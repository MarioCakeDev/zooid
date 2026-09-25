import { describe, it, expect } from 'vitest'
import type {
  ToolCallEvent,
  ToolCallUpdateEvent,
  PlanEvent,
} from '@zooid/acp-client'
import {
  toToolCallBody,
  toUpdateBody,
  toPlanBody,
  toErrorBody,
  toAvailableCommandsBody,
  toTurnEndBody,
  toActivityNoticeBody,
  activityDetail,
  toolStatusLabel,
  toolEntryLine,
  toolParamsText,
  toolOutputText,
  turnGroupBody,
  turnGroupHtml,
  turnGroupSummary,
  turnFinalBody,
  turnMirrorNoticeContent,
  turnMirrorEditContent,
  type TurnToolEntry,
} from './event-encoders.js'

describe('toToolCallBody', () => {
  it('maps required + optional fields with snake_case keys', () => {
    const evt: ToolCallEvent = {
      type: 'tool_call',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      title: 'Run tests',
      kind: 'execute',
      status: 'pending',
    }
    expect(toToolCallBody(evt)).toEqual({
      session_id: 'sess-1',
      tool_call_id: 'tc-1',
      title: 'Run tests',
      kind: 'execute',
      status: 'pending',
    })
  })

  it('omits optional fields when undefined', () => {
    const evt: ToolCallEvent = {
      type: 'tool_call',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      title: 'Run tests',
    }
    expect(toToolCallBody(evt)).toEqual({
      session_id: 'sess-1',
      tool_call_id: 'tc-1',
      title: 'Run tests',
    })
  })

  it('forwards rawInput as raw_input (snake_case) and locations', () => {
    const evt: ToolCallEvent = {
      type: 'tool_call',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      title: 'Read file',
      kind: 'read',
      rawInput: { filepath: '/abs/path/notes.md' },
      locations: [{ path: '/abs/path/notes.md' }],
    }
    expect(toToolCallBody(evt)).toEqual({
      session_id: 'sess-1',
      tool_call_id: 'tc-1',
      title: 'Read file',
      kind: 'read',
      raw_input: { filepath: '/abs/path/notes.md' },
      locations: [{ path: '/abs/path/notes.md' }],
    })
  })

  it('truncates long string values inside rawInput', () => {
    const longDiff = 'a'.repeat(500)
    const evt: ToolCallEvent = {
      type: 'tool_call',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      title: 'Edit file',
      kind: 'edit',
      rawInput: { filepath: '/abs/short.md', diff: longDiff },
    }
    const body = toToolCallBody(evt) as { raw_input: Record<string, unknown> }
    expect(body.raw_input.filepath).toBe('/abs/short.md')
    expect(body.raw_input.diff).toBe('a'.repeat(250) + '… [truncated]')
  })
})

describe('toUpdateBody', () => {
  it('passes through status/kind/content with snake_case keys', () => {
    const evt: ToolCallUpdateEvent = {
      type: 'tool_call_update',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'done' } }] as never,
    }
    expect(toUpdateBody(evt)).toEqual({
      session_id: 'sess-1',
      tool_call_id: 'tc-1',
      status: 'completed',
      content: evt.content,
    })
  })

  it('omits absent optional fields', () => {
    const evt: ToolCallUpdateEvent = {
      type: 'tool_call_update',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
    }
    expect(toUpdateBody(evt)).toEqual({
      session_id: 'sess-1',
      tool_call_id: 'tc-1',
    })
  })
})

describe('toPlanBody', () => {
  it('forwards entries verbatim under session_id', () => {
    const evt: PlanEvent = {
      type: 'plan',
      sessionId: 'sess-1',
      entries: [{ content: 'step a', priority: 'high', status: 'pending' }] as never,
    }
    expect(toPlanBody(evt)).toEqual({
      session_id: 'sess-1',
      entries: evt.entries,
    })
  })
})

describe('toAvailableCommandsBody', () => {
  it('encodes available_commands into the body ZNC021 decodes', () => {
    expect(
      toAvailableCommandsBody({
        type: 'available_commands',
        sessionId: 's-1',
        commands: [
          { name: 'plan', description: 'Switch to plan mode' },
          { name: 'compact', description: 'Compact the context' },
        ],
      }),
    ).toEqual({
      session_id: 's-1',
      available_commands: [
        { name: 'plan', description: 'Switch to plan mode' },
        { name: 'compact', description: 'Compact the context' },
      ],
    })
  })
})

describe('toErrorBody', () => {
  const threadRoot = '$root-event-id'

  it('encodes a full error TapEvent including acp_error and recovery URL', () => {
    const body = toErrorBody(
      {
        kind: 'error',
        agentId: 'alice',
        sessionId: 'sess-1',
        turnId: 'turn-1',
        code: 'auth_missing',
        message: 'Authentication required',
        detail: 'claude-agent-acp returned RequestError on session/prompt',
        transient: false,
        acp_error: { code: -32000, message: 'Authentication required' },
      },
      threadRoot,
    )
    expect(body).toMatchObject({
      body: '⚠ [auth_missing] Authentication required',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      code: 'auth_missing',
      message: 'Authentication required',
      detail: 'claude-agent-acp returned RequestError on session/prompt',
      transient: false,
      acp_error: { code: -32000, message: 'Authentication required' },
      'm.relates_to': { rel_type: 'm.thread', event_id: '$root-event-id' },
    })
    expect(body.recovery).toMatch(/^https:\/\/zooid\.dev\/docs\//)
  })

  it('carries no msgtype — dev.zooid.error is not m.room.message, so the field is meaningless', () => {
    const body = toErrorBody(
      { kind: 'error', agentId: 'a', sessionId: 's', turnId: 't', code: 'auth_missing', message: 'x', transient: false },
      threadRoot,
    )
    expect(body).not.toHaveProperty('msgtype')
  })

  it('truncates message to 250 chars and detail to 2000 chars', () => {
    const body = toErrorBody(
      {
        kind: 'error',
        agentId: 'a',
        sessionId: 's',
        turnId: 't',
        code: 'internal',
        message: 'x'.repeat(500),
        detail: 'y'.repeat(5000),
        transient: false,
      },
      threadRoot,
    )
    expect((body.message as string).length).toBe(250)
    expect((body.detail as string).length).toBe(2000)
  })

  it('omits turn_id when null and omits acp_error when undefined', () => {
    const body = toErrorBody(
      {
        kind: 'error',
        agentId: 'a',
        sessionId: 's',
        turnId: null,
        code: 'container_exit',
        message: 'Container exited',
        transient: true,
      },
      threadRoot,
    )
    expect(body.turn_id).toBeUndefined()
    expect(body.acp_error).toBeUndefined()
  })

  it('omits session_id when null (failure preceded session/new)', () => {
    const body = toErrorBody(
      {
        kind: 'error',
        agentId: 'a',
        sessionId: null,
        turnId: null,
        code: 'image_pull_failed',
        message: 'pull failed',
        transient: true,
      },
      threadRoot,
    )
    expect(body.session_id).toBeUndefined()
  })
})

describe('toTurnEndBody', () => {
  it('carries the produced_output flag ZOD076 reads', () => {
    expect(toTurnEndBody({ agentId: 'claude', sessionId: 's1', producedOutput: true }, '$root')).toEqual({
      body: 'claude finished',
      agent_id: 'claude',
      session_id: 's1',
      produced_output: true,
      'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
    })
  })

  it('carries a preview of the final message — the prose itself never pushes', () => {
    // Agent prose goes out as m.notice and is silenced by
    // .m.rule.suppress_notices, so without this the only notification the user
    // gets says an agent finished and nothing about what it said.
    const out = toTurnEndBody(
      { agentId: 'claude', sessionId: 's1', producedOutput: true, lastMessage: 'the deploy is green' },
      '$root',
    )
    expect(out.last_message).toBe('the deploy is green')
    // body stays the turn-boundary summary a generic Matrix client renders.
    expect(out.body).toBe('claude finished')
  })

  it('collapses whitespace and truncates a long final message', () => {
    const out = toTurnEndBody(
      {
        agentId: 'claude',
        sessionId: 's1',
        producedOutput: true,
        lastMessage: '  line one\n\nline two   ' + 'x'.repeat(400),
      },
      '$root',
    )
    const preview = out.last_message as string
    expect(preview.length).toBe(140)
    expect(preview.startsWith('line one line two ')).toBe(true)
    expect(preview).not.toContain('\n')
  })

  it('omits last_message entirely when the turn produced nothing', () => {
    const out = toTurnEndBody({ agentId: 'claude', sessionId: 's1', producedOutput: false }, '$root')
    expect('last_message' in out).toBe(false)
  })

  it('marks an empty turn', () => {
    const out = toTurnEndBody(
      { agentId: 'claude', sessionId: 's1', producedOutput: false },
      '$root',
    )
    expect(out.produced_output).toBe(false)
    expect(out.body).toBe('claude finished without output')
  })

  it('carries no msgtype — a vestigial m.notice here would collide with .m.rule.suppress_notices', () => {
    const out = toTurnEndBody({ agentId: 'a', sessionId: 's', producedOutput: true }, '$r')
    expect(out).not.toHaveProperty('msgtype')
  })
})

describe('toActivityNoticeBody', () => {
  it('names the agent and the command it wants to run, and drops the reply hint', () => {
    const body = toActivityNoticeBody(
      'dev.zooid.approval_request',
      {
        approval_id: 'a1b2',
        tool_call_id: 'tc-1',
        tool_kind: 'execute',
        tool_title: 'bash',
        tool_input: { command: 'git push --force origin main' },
        options: [],
      },
      'infra',
    )
    expect(body).toBe('🔐 infra wants to run: git push --force origin main — react 👍/👎')
    expect(body).not.toContain('reply')
    expect(body).not.toContain('approve ')
    expect(body).not.toContain('deny ')
  })

  it('names the file a write/edit tool wants to touch', () => {
    expect(
      toActivityNoticeBody(
        'dev.zooid.approval_request',
        {
          tool_kind: 'edit',
          tool_title: 'edit',
          tool_input: { filepath: '/workspace/src/x.ts' },
        },
        'dev',
      ),
    ).toBe('🔐 dev wants to edit: /workspace/src/x.ts — react 👍/👎')
  })

  it('falls back to the tool title when the input carries no command or path', () => {
    expect(
      toActivityNoticeBody(
        'dev.zooid.approval_request',
        { tool_title: 'git push', tool_input: { ref: 'main' } },
        'architect',
      ),
    ).toBe('🔐 architect wants to use: git push — react 👍/👎')
  })

  it('clamps a long approval command so the notice stays glanceable', () => {
    const body = toActivityNoticeBody(
      'dev.zooid.approval_request',
      { tool_kind: 'execute', tool_input: { command: 'x'.repeat(500) } },
      'dev',
    )
    expect(body).toBeDefined()
    expect(body!.length).toBeLessThanOrEqual(400)
    expect(body!.endsWith('… — react 👍/👎')).toBe(true)
  })

  it('mirrors an error, reusing its body (a stock client cannot render the custom event)', () => {
    expect(
      toActivityNoticeBody('dev.zooid.error', { body: '⚠ [x] boom', code: 'x' }),
    ).toBe('⚠ [x] boom')
  })

  it('does not mirror the foldable activity events (folded into the per-turn line)', () => {
    expect(
      toActivityNoticeBody('dev.zooid.tool_call', { title: 'Run tests', status: 'pending' }),
    ).toBeNull()
    expect(
      toActivityNoticeBody('dev.zooid.tool_call_update', { tool_call_id: 'tc-1', status: 'completed' }),
    ).toBeNull()
    expect(toActivityNoticeBody('dev.zooid.plan', { entries: [{ content: 'a' }] })).toBeNull()
    expect(
      toActivityNoticeBody('dev.zooid.available_commands_update', { available_commands: [] }),
    ).toBeNull()
  })

  it('does not mirror the turn.end boundary marker', () => {
    expect(
      toActivityNoticeBody('dev.zooid.turn.end', { body: 'claude finished', agent_id: 'claude' }),
    ).toBeNull()
  })

  it('does not mirror the workforce state event or unknown types', () => {
    expect(toActivityNoticeBody('dev.zooid.workforce', { version: 1 })).toBeNull()
    expect(toActivityNoticeBody('dev.zooid.something_new', { foo: 1 })).toBeNull()
  })

  it('does not mirror a body-carrying event other than error', () => {
    expect(toActivityNoticeBody('dev.zooid.plan', { body: 'custom', entries: [] })).toBeNull()
  })
})

describe('toolParamsText', () => {
  it('renders an object as compact key=value pairs', () => {
    expect(toolParamsText({ command: 'git status' })).toBe('command=git status')
    expect(toolParamsText({ filepath: '/a/b.ts', line: 3 })).toBe('filepath=/a/b.ts, line=3')
  })

  it('renders a bare string as itself', () => {
    expect(toolParamsText('git status')).toBe('git status')
  })

  it('collapses whitespace and clamps a long value', () => {
    expect(toolParamsText({ command: 'a\n  b' })).toBe('command=a b')
    const clamped = toolParamsText({ command: 'x'.repeat(300) })!
    expect(clamped).toHaveLength(200)
    expect(clamped.startsWith('command=xxx')).toBe(true)
    expect(clamped.endsWith('…')).toBe(true)
  })

  it('returns undefined for nullish or empty input', () => {
    expect(toolParamsText(undefined)).toBeUndefined()
    expect(toolParamsText(null)).toBeUndefined()
    expect(toolParamsText({})).toBeUndefined()
    expect(toolParamsText('')).toBeUndefined()
  })
})

describe('toolOutputText', () => {
  it('extracts text content blocks', () => {
    expect(
      toolOutputText([{ type: 'content', content: { type: 'text', text: 'ok, 12 passed' } }]),
    ).toBe('ok, 12 passed')
  })

  it('joins multiple entries with a newline', () => {
    expect(
      toolOutputText([
        { type: 'content', content: { type: 'text', text: 'first' } },
        { type: 'content', content: { type: 'text', text: 'second' } },
      ]),
    ).toBe('first\nsecond')
  })

  it('renders a diff entry from its path and new text', () => {
    expect(toolOutputText([{ type: 'diff', path: '/a/b.ts', newText: '+line' }])).toBe(
      '/a/b.ts: +line',
    )
  })

  it('clamps each long entry', () => {
    const out = toolOutputText([
      { type: 'content', content: { type: 'text', text: 'x'.repeat(300) } },
    ])!
    expect(out).toHaveLength(200)
    expect(out.endsWith('…')).toBe(true)
  })

  it('clamps the joined output per tool, not just per entry', () => {
    const out = toolOutputText([
      { type: 'content', content: { type: 'text', text: 'a'.repeat(200) } },
      { type: 'content', content: { type: 'text', text: 'b'.repeat(200) } },
      { type: 'content', content: { type: 'text', text: 'c'.repeat(200) } },
    ])!
    expect(out).toHaveLength(200)
    expect(out.endsWith('…')).toBe(true)
  })

  it('renders a terminal entry as its id', () => {
    expect(toolOutputText([{ type: 'terminal', terminalId: 't-1' }])).toBe('terminal t-1')
  })

  it('returns undefined when nothing is renderable', () => {
    expect(toolOutputText(undefined)).toBeUndefined()
    expect(toolOutputText([])).toBeUndefined()
    expect(toolOutputText([{ type: 'content', content: { type: 'image' } }])).toBeUndefined()
  })
})

describe('turnGroupSummary', () => {
  const entry = (over: Partial<TurnToolEntry>): TurnToolEntry => ({
    toolCallId: 'tc-1',
    title: 'bash',
    ...over,
  })

  it('reads `🔧 <agent>: <N tools> — <last tool> — <status>`', () => {
    expect(turnGroupSummary('dev', [entry({ title: 'bash', status: 'completed' })])).toBe(
      '🔧 dev: 1 tool — bash — done',
    )
    expect(
      turnGroupSummary('dev', [
        entry({ title: 'a' }),
        entry({ toolCallId: 'tc-2', title: 'b', status: 'in_progress' }),
      ]),
    ).toBe('🔧 dev: 2 tools — b — running')
  })

  it('omits the status label when the last tool has none', () => {
    expect(turnGroupSummary('dev', [entry({ title: 'bash' })])).toBe('🔧 dev: 1 tool — bash')
  })

  it('reads a plan-only group as 0 tools — plan', () => {
    expect(turnGroupSummary('dev', [], 'plan (2 steps)')).toBe('🔧 dev: 0 tools — plan')
  })
})

describe('turnGroupBody', () => {
  const entry = (over: Partial<TurnToolEntry>): TurnToolEntry => ({
    toolCallId: 'tc-1',
    title: 'bash',
    ...over,
  })

  it('renders the summary then each tool line, params and output, in order', () => {
    expect(
      turnGroupBody('dev', [
        entry({
          title: 'bash',
          status: 'in_progress',
          params: 'command=git status',
          output: 'clean',
        }),
        entry({
          toolCallId: 'tc-2',
          title: 'edit src/x.ts',
          status: 'completed',
          params: 'filepath=src/x.ts',
        }),
      ]),
    ).toBe(
      [
        '🔧 dev: 2 tools — edit src/x.ts — done',
        '⏳ bash',
        '⚙ command=git status',
        '────────────────',
        '↳ clean',
        '',
        '────────────────',
        '✓ edit src/x.ts — done',
        '⚙ filepath=src/x.ts',
      ].join('\n'),
    )
  })

  it('draws a rule between a tool’s params and its output (Option 3)', () => {
    const body = turnGroupBody('dev', [
      entry({ title: 'bash', params: 'command=npm test, cwd=/workspace', output: '12 passed' }),
    ])
    expect(body.split('\n')).toEqual([
      '🔧 dev: 1 tool — bash',
      '• bash',
      '⚙ command=npm test, cwd=/workspace',
      '────────────────',
      '↳ 12 passed',
    ])
  })

  it('separates consecutive tool sections with a blank line and a rule', () => {
    const body = turnGroupBody('dev', [
      entry({ toolCallId: 'tc-1', title: 'bash', status: 'completed', output: 'clean' }),
      entry({ toolCallId: 'tc-2', title: 'Read file', status: 'completed' }),
    ])
    expect(body.split('\n')).toEqual([
      '🔧 dev: 2 tools — Read file — done',
      '✓ bash — done',
      '↳ clean',
      '',
      '────────────────',
      '✓ Read file — done',
    ])
  })

  it('adds no rule when a tool has params or output alone', () => {
    expect(turnGroupBody('dev', [entry({ title: 'bash', params: 'command=ls' })])).toBe(
      '🔧 dev: 1 tool — bash\n• bash\n⚙ command=ls',
    )
    expect(turnGroupBody('dev', [entry({ title: 'bash', output: 'clean' })])).toBe(
      '🔧 dev: 1 tool — bash\n• bash\n↳ clean',
    )
  })

  it('renders a multi-line output one `↳` line per entry', () => {
    expect(
      turnGroupBody('dev', [entry({ title: 'bash', output: 'first\nsecond' })]),
    ).toBe('🔧 dev: 1 tool — bash\n• bash\n↳ first\n↳ second')
  })

  it('appends the plan detail as the last line', () => {
    expect(turnGroupBody('dev', [entry({ title: 'Read file' })], 'plan (2 steps)')).toBe(
      '🔧 dev: 1 tool — Read file\n• Read file\n🗒 plan (2 steps)',
    )
  })

  it('caps a runaway group to its newest entries and summarises the hidden remainder', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      entry({ toolCallId: `tc-${i}`, title: `tool-${i}`, status: 'completed' }),
    )
    const body = turnGroupBody('dev', many)
    const lines = body.split('\n')
    expect(lines[0]).toBe('🔧 dev: 25 tools — tool-24 — done')
    expect(lines[1]).toBe('… 5 more')
    expect(lines[2]).toBe('✓ tool-5 — done')
    expect(lines.at(-1)).toBe('✓ tool-24 — done')
    expect(body).not.toContain('✓ tool-4 — done')
  })

  it('stays under the total-size cap even with fat params and output', () => {
    const fat = Array.from({ length: 20 }, (_, i) =>
      entry({
        toolCallId: `tc-${i}`,
        title: `tool-${i}`,
        status: 'completed',
        params: 'p'.repeat(200),
        output: 'o'.repeat(200),
      }),
    )
    const body = turnGroupBody('dev', fat)
    expect(body).toMatch(/… \d+ more/)
    expect(body).not.toContain('✓ tool-0 — done')
    expect(body.length).toBeLessThan(9000)
  })

  it('always shows the newest entry, even when it alone exceeds the size budget', () => {
    const body = turnGroupBody('dev', [
      entry({ title: 'bash', status: 'completed', output: 'x'.repeat(9000) }),
    ])
    expect(body).toContain('✓ bash — done')
    expect(body).toContain('↳ ')
    expect(body).not.toContain('more')
  })
})

describe('turnGroupHtml', () => {
  const entry = (over: Partial<TurnToolEntry>): TurnToolEntry => ({
    toolCallId: 'tc-1',
    title: 'bash',
    ...over,
  })

  it('wraps the group in one collapsed <details> whose <summary> is first', () => {
    const html = turnGroupHtml('dev', [
      entry({ title: 'bash', status: 'in_progress' }),
      entry({ toolCallId: 'tc-2', title: 'edit src/x.ts', status: 'completed' }),
    ])
    expect(html).toBe(
      '<details><summary>🔧 dev: 2 tools — edit src/x.ts — done</summary>' +
        '⏳ bash<hr>✓ edit src/x.ts — done</details>',
    )
    expect(html.startsWith('<details><summary>')).toBe(true)
    expect(html).not.toContain('<details open')
    expect(html).not.toContain(' open>')
  })

  it('nests a <details> per tool with input/output in one <pre><code> block', () => {
    const html = turnGroupHtml('dev', [
      entry({
        title: 'bash',
        status: 'completed',
        params: 'command=git status',
        output: 'clean tree',
      }),
    ])
    expect(html).toBe(
      '<details><summary>🔧 dev: 1 tool — bash — done</summary>' +
        '<details><summary>✓ bash — done</summary>' +
        '<pre><code>⚙ command=git status\n\n↳ clean tree</code></pre></details>' +
        '</details>',
    )
    // The tool line is the inner <summary>; the input/output are its code block.
    expect(html).toContain('<details><summary>✓ bash — done</summary><pre><code>⚙ command=git status')
    // Newlines inside the block are literal, not <br>.
    expect(html).not.toContain('↳ clean tree<br>')
  })

  it('does not wrap a tool with no input/output in a dead <details>', () => {
    const html = turnGroupHtml('dev', [entry({ title: 'Read file', status: 'completed' })])
    expect(html).toBe(
      '<details><summary>🔧 dev: 1 tool — Read file — done</summary>✓ Read file — done</details>',
    )
    expect(html.match(/<details>/g)).toHaveLength(1)
  })

  it('renders the inter-tool separation as a bare <hr> (no <br> padding)', () => {
    const html = turnGroupHtml('dev', [
      entry({
        toolCallId: 'tc-1',
        title: 'bash',
        status: 'completed',
        params: 'command=ls',
        output: 'clean',
      }),
      entry({ toolCallId: 'tc-2', title: 'Read file', status: 'completed' }),
    ])
    expect(html).toBe(
      '<details><summary>🔧 dev: 2 tools — Read file — done</summary>' +
        '<details><summary>✓ bash — done</summary>' +
        '<pre><code>⚙ command=ls\n\n↳ clean</code></pre></details>' +
        '<hr>✓ Read file — done</details>',
    )
    expect(html).not.toContain('<br><hr>')
    expect(html).not.toContain('<hr><br>')
  })

  it('escapes HTML-significant text in the tool line, params and output', () => {
    const html = turnGroupHtml('dev', [
      entry({ title: '<b>bash</b>', params: 'cmd=<i>&</i>', output: '<u>x</u>' }),
    ])
    expect(html).toContain('&lt;b&gt;bash&lt;/b&gt;')
    expect(html).toContain('cmd=&lt;i&gt;&amp;&lt;/i&gt;')
    expect(html).toContain('&lt;u&gt;x&lt;/u&gt;')
    expect(html).not.toContain('<b>')
    expect(html).not.toContain('<i>')
    expect(html).not.toContain('<u>')
  })

  it('escapes HTML-significant characters in the summary, params and output', () => {
    const html = turnGroupHtml('dev', [
      entry({
        title: '<script>&"x"</script>',
        params: 'cmd=<b>&</b>',
        output: '<i>"o"</i>',
      }),
    ])
    expect(html).toContain('&lt;script&gt;&amp;&quot;x&quot;&lt;/script&gt;')
    expect(html).toContain('cmd=&lt;b&gt;&amp;&lt;/b&gt;')
    expect(html).toContain('&lt;i&gt;&quot;o&quot;&lt;/i&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<b>')
    expect(html).not.toContain('<i>')
  })

  it('renders the plan detail as a final <br> segment', () => {
    expect(turnGroupHtml('dev', [entry({ title: 'Read file' })], 'plan (2 steps)')).toBe(
      '<details><summary>🔧 dev: 1 tool — Read file</summary>• Read file<br>🗒 plan (2 steps)</details>',
    )
  })

  it('caps a runaway group with a `… K more` line', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      entry({ toolCallId: `tc-${i}`, title: `tool-${i}`, status: 'completed' }),
    )
    const html = turnGroupHtml('dev', many)
    expect(
      html.startsWith(
        '<details><summary>🔧 dev: 25 tools — tool-24 — done</summary>… 5 more<hr>✓ tool-5 — done<hr>',
      ),
    ).toBe(true)
    expect(html.endsWith('✓ tool-24 — done</details>')).toBe(true)
    expect(html).not.toContain('tool-4 — done')
  })
})

describe('turnFinalBody', () => {
  it('summarizes the turn with the agent name', () => {
    expect(turnFinalBody('dev', { toolCount: 3, fileCount: 2 }, false)).toBe(
      '✅ dev: done · 3 tools · 2 files',
    )
  })

  it('pluralizes a single tool and a single file', () => {
    expect(turnFinalBody('dev', { toolCount: 1, fileCount: 1 }, false)).toBe(
      '✅ dev: done · 1 tool · 1 file',
    )
    expect(turnFinalBody('dev', { toolCount: 2, fileCount: 1 }, false)).toBe(
      '✅ dev: done · 2 tools · 1 file',
    )
  })

  it('marks a failed turn', () => {
    expect(turnFinalBody('dev', { toolCount: 1, fileCount: 0 }, true)).toBe(
      '⚠️ dev: failed · 1 tool · 0 files',
    )
  })
})

describe('toolStatusLabel', () => {
  it('maps the ACP statuses to human labels', () => {
    expect(toolStatusLabel('pending')).toBe('pending')
    expect(toolStatusLabel('in_progress')).toBe('running')
    expect(toolStatusLabel('completed')).toBe('done')
    expect(toolStatusLabel('failed')).toBe('failed')
  })

  it('returns undefined for an absent or unknown status', () => {
    expect(toolStatusLabel(undefined)).toBeUndefined()
    expect(toolStatusLabel('weird')).toBeUndefined()
  })
})

describe('toolEntryLine', () => {
  const entry = (over: Partial<TurnToolEntry>): TurnToolEntry => ({
    toolCallId: 'tc-1',
    title: 'bash',
    ...over,
  })

  it('renders a completed tool as ✓ <title> — done', () => {
    expect(toolEntryLine(entry({ status: 'completed' }))).toBe('✓ bash — done')
  })

  it('renders an in-flight tool with a ⏳ glyph and no label', () => {
    expect(toolEntryLine(entry({ title: 'edit src/x.ts', status: 'in_progress' }))).toBe(
      '⏳ edit src/x.ts',
    )
  })

  it('renders a failed tool as ✗ <title> — failed', () => {
    expect(toolEntryLine(entry({ title: 'edit', status: 'failed' }))).toBe('✗ edit — failed')
  })

  it('renders a statusless tool with a neutral glyph', () => {
    expect(toolEntryLine(entry({ title: 'Read file' }))).toBe('• Read file')
  })

  it('shows only the title and status — never raw tool output', () => {
    const line = toolEntryLine(entry({ status: 'completed' }))
    expect(line).toBe('✓ bash — done')
    expect(line).not.toContain('·')
  })
})

describe('activityDetail', () => {
  it('returns undefined for tool activity — rendered from the entry list instead', () => {
    expect(
      activityDetail('dev.zooid.tool_call', { title: 'Run tests', status: 'pending' }),
    ).toBeUndefined()
    expect(
      activityDetail('dev.zooid.tool_call_update', {
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'ok, 12 passed' } }],
      }),
    ).toBeUndefined()
  })

  it('summarizes a plan by step count', () => {
    expect(activityDetail('dev.zooid.plan', { entries: [{ content: 'a' }, { content: 'b' }] })).toBe(
      'plan (2 steps)',
    )
    expect(activityDetail('dev.zooid.plan', { entries: [] })).toBe('plan')
  })

  it('summarizes the command roster by count', () => {
    expect(
      activityDetail('dev.zooid.available_commands_update', {
        available_commands: [{ name: 'help' }, { name: 'clear' }],
      }),
    ).toBe('commands (2)')
  })

  it('returns undefined for a non-foldable event', () => {
    expect(activityDetail('dev.zooid.error', { body: 'x' })).toBeUndefined()
  })
})

describe('turnMirrorNoticeContent', () => {
  it('is a single threaded m.notice line carrying the marker', () => {
    expect(turnMirrorNoticeContent('⏳ bash', '$root')).toEqual({
      msgtype: 'm.notice',
      body: '⏳ bash',
      'dev.zooid.mirror': true,
      'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
    })
  })

  it('adds the HTML format and formatted_body when a formatted body is given', () => {
    expect(turnMirrorNoticeContent('🔧 dev: ⏳ bash\n✓ edit', '$root', '🔧 dev: ⏳ bash<br>✓ edit')).toEqual(
      {
        msgtype: 'm.notice',
        body: '🔧 dev: ⏳ bash\n✓ edit',
        format: 'org.matrix.custom.html',
        formatted_body: '🔧 dev: ⏳ bash<br>✓ edit',
        'dev.zooid.mirror': true,
        'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
      },
    )
  })
})

describe('turnMirrorEditContent', () => {
  it('is an m.replace of the original, with the thread relation in m.new_content', () => {
    expect(turnMirrorEditContent('$notice', '✓ bash — done', '$root')).toEqual({
      msgtype: 'm.notice',
      body: '* ✓ bash — done',
      'dev.zooid.mirror': true,
      'm.new_content': {
        msgtype: 'm.notice',
        body: '✓ bash — done',
        'dev.zooid.mirror': true,
        'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
      },
      'm.relates_to': { rel_type: 'm.replace', event_id: '$notice' },
    })
  })

  it('preserves the multi-line shape in the HTML edit of m.new_content', () => {
    expect(
      turnMirrorEditContent(
        '$notice',
        '🔧 dev: ⏳ bash\n✓ edit — done',
        '$root',
        '🔧 dev: ⏳ bash<br>✓ edit — done',
      ),
    ).toEqual({
      msgtype: 'm.notice',
      body: '* 🔧 dev: ⏳ bash\n✓ edit — done',
      format: 'org.matrix.custom.html',
      formatted_body: '* 🔧 dev: ⏳ bash<br>✓ edit — done',
      'dev.zooid.mirror': true,
      'm.new_content': {
        msgtype: 'm.notice',
        body: '🔧 dev: ⏳ bash\n✓ edit — done',
        format: 'org.matrix.custom.html',
        formatted_body: '🔧 dev: ⏳ bash<br>✓ edit — done',
        'dev.zooid.mirror': true,
        'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
      },
      'm.relates_to': { rel_type: 'm.replace', event_id: '$notice' },
    })
  })
})
