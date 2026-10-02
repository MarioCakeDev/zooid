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
  toolIcon,
  toolEntryLine,
  toolEntryPath,
  toolEntryMachine,
  toolParamsText,
  toolOutputText,
  turnGroupBody,
  turnGroupHtml,
  turnGroupSummary,
  turnFinalBody,
  turnMirrorNoticeContent,
  turnMirrorEditContent,
  DIFF_PARAM_KEYS,
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

  it('forwards the title and diffs a write reported as kind:"edit"', () => {
    const evt: ToolCallUpdateEvent = {
      type: 'tool_call_update',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      kind: 'edit',
      title: 'Write /tmp/x',
      rawInput: { filePath: '/tmp/x', content: 'x\ny\n' },
    }
    const out = toUpdateBody(evt)
    expect(out.title).toBe('Write /tmp/x')
    expect(out.diff).toMatch(/^--- \/dev\/null/)
    expect(out.diff).toContain('+x')
    expect(out.diff).toContain('+y')
  })

  it('does not fabricate a creation for an in-place edit with a content key', () => {
    const evt: ToolCallUpdateEvent = {
      type: 'tool_call_update',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      kind: 'edit',
      title: 'Edit /tmp/x',
      rawInput: { filePath: '/tmp/x', content: 'x\ny\n' },
    }
    const out = toUpdateBody(evt)
    expect(out.title).toBe('Edit /tmp/x')
    expect(out.diff).toBeUndefined()
    // Still a params line, not a diff.
    expect(out.raw_input).toEqual({ filePath: '/tmp/x', content: 'x\ny\n' })
  })

  it('still diffs an update carrying oldString/newString', () => {
    const evt: ToolCallUpdateEvent = {
      type: 'tool_call_update',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      kind: 'edit',
      title: 'Edit /tmp/x',
      rawInput: { filePath: '/tmp/x', oldString: 'a\n', newString: 'b\n' },
    }
    const out = toUpdateBody(evt)
    expect(out.diff).toContain('--- a//tmp/x')
    expect(out.diff).toContain('-a')
    expect(out.diff).toContain('+b')
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

  it('drops the omitted keys and keeps the rest of the input', () => {
    const raw = {
      filePath: 'src/x.ts',
      oldString: 'a',
      newString: 'b',
      replace_all: true,
      expected_replacements: 2,
    }
    expect(toolParamsText(raw, DIFF_PARAM_KEYS)).toBe(
      'filePath=src/x.ts, replace_all=true, expected_replacements=2',
    )
    // Without the omit set nothing is filtered.
    expect(toolParamsText(raw)).toContain('oldString=a')
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

  it('reads `🔧 <agent>: <N tools> — <last tool>` with no status word', () => {
    expect(turnGroupSummary('dev', [entry({ title: 'bash', status: 'completed' })])).toBe(
      '🔧 dev: 1 tool — 🐚 bash @local',
    )
    expect(
      turnGroupSummary('dev', [
        entry({ title: 'a' }),
        entry({ toolCallId: 'tc-2', title: 'b', status: 'in_progress' }),
      ]),
    ).toBe('🔧 dev: 2 tools — 🛠 b')
  })

  it('names the last tool’s file instead of a read/write tool word', () => {
    expect(
      turnGroupSummary('dev', [
        entry({ title: 'read /workspace/src/x.ts', path: '/workspace/src/x.ts' }),
      ]),
    ).toBe('🔧 dev: 1 tool — 📖 /workspace/src/x.ts')
  })

  it('appends the machine the last shell call ran on', () => {
    expect(
      turnGroupSummary('dev', [entry({ title: 'ssh_run-command', machine: 'coolify' })]),
    ).toBe('🔧 dev: 1 tool — 🐚 ssh_run-command @coolify')
    expect(turnGroupSummary('dev', [entry({ title: 'bash' })])).toBe(
      '🔧 dev: 1 tool — 🐚 bash @local',
    )
  })

  it('keeps the machine on the summary line even when the last tool is clamped', () => {
    const summary = turnGroupSummary('dev', [entry({ title: `bash ${'x'.repeat(400)}` })])
    expect(summary.endsWith('… @local')).toBe(true)
    expect(summary.length).toBeLessThanOrEqual(200)
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
        '🔧 dev: 2 tools — ✏️ edit src/x.ts',
        '⏳ 🐚 bash @local',
        'command=git status',
        '────────────────',
        'clean',
        '',
        '────────────────',
        '✓ ✏️ edit src/x.ts',
        'filepath=src/x.ts',
      ].join('\n'),
    )
  })

  it('draws a rule between a tool’s params and its output (Option 3)', () => {
    const body = turnGroupBody('dev', [
      entry({ title: 'bash', params: 'command=npm test, cwd=/workspace', output: '12 passed' }),
    ])
    expect(body.split('\n')).toEqual([
      '🔧 dev: 1 tool — 🐚 bash @local',
      '• 🐚 bash @local',
      'command=npm test, cwd=/workspace',
      '────────────────',
      '12 passed',
    ])
  })

  it('separates consecutive tool sections with a blank line and a rule', () => {
    const body = turnGroupBody('dev', [
      entry({ toolCallId: 'tc-1', title: 'bash', status: 'completed', output: 'clean' }),
      entry({ toolCallId: 'tc-2', title: 'Read file', status: 'completed' }),
    ])
    expect(body.split('\n')).toEqual([
      '🔧 dev: 2 tools — 📖 Read file',
      '✓ 🐚 bash @local',
      'clean',
      '',
      '────────────────',
      '✓ 📖 Read file',
    ])
  })

  it('shows the params line and the diff together, params first', () => {
    const body = turnGroupBody('dev', [
      entry({
        title: 'edit src/x.ts',
        status: 'completed',
        params: 'filePath=src/x.ts, replace_all=false',
        diff: '--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b',
        output: 'ok',
      }),
    ])
    expect(body.split('\n')).toEqual([
      '🔧 dev: 1 tool — ✏️ edit src/x.ts',
      '✓ ✏️ edit src/x.ts',
      'filePath=src/x.ts, replace_all=false',
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '────────────────',
      'ok',
    ])
  })

  it('adds no rule when a tool has params or output alone', () => {
    expect(turnGroupBody('dev', [entry({ title: 'bash', params: 'command=ls' })])).toBe(
      '🔧 dev: 1 tool — 🐚 bash @local\n• 🐚 bash @local\ncommand=ls',
    )
    expect(turnGroupBody('dev', [entry({ title: 'bash', output: 'clean' })])).toBe(
      '🔧 dev: 1 tool — 🐚 bash @local\n• 🐚 bash @local\nclean',
    )
  })

  it('renders a multi-line output one line per entry', () => {
    expect(
      turnGroupBody('dev', [entry({ title: 'bash', output: 'first\nsecond' })]),
    ).toBe('🔧 dev: 1 tool — 🐚 bash @local\n• 🐚 bash @local\nfirst\nsecond')
  })

  it('appends the plan detail as the last line', () => {
    expect(turnGroupBody('dev', [entry({ title: 'Read file' })], 'plan (2 steps)')).toBe(
      '🔧 dev: 1 tool — 📖 Read file\n• 📖 Read file\n🗒 plan (2 steps)',
    )
  })

  it('caps a runaway group to its newest entries and summarises the hidden remainder', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      entry({ toolCallId: `tc-${i}`, title: `tool-${i}`, status: 'completed' }),
    )
    const body = turnGroupBody('dev', many)
    const lines = body.split('\n')
    expect(lines[0]).toBe('🔧 dev: 25 tools — 🛠 tool-24')
    expect(lines[1]).toBe('… 5 more')
    expect(lines[2]).toBe('✓ 🛠 tool-5')
    expect(lines.at(-1)).toBe('✓ 🛠 tool-24')
    expect(body).not.toContain('✓ 🛠 tool-4')
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
    expect(body).not.toContain('✓ 🛠 tool-0')
    expect(body.length).toBeLessThan(9000)
  })

  it('always shows the newest entry, even when it alone exceeds the size budget', () => {
    const body = turnGroupBody('dev', [
      entry({ title: 'bash', status: 'completed', output: 'x'.repeat(9000) }),
    ])
    expect(body).toContain('✓ 🐚 bash @local')
    expect(body).toContain('x'.repeat(20))
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
      '<details><summary>🔧 dev: 2 tools — ✏️ edit src/x.ts</summary>' +
        '⏳ 🐚 bash @local<br>✓ ✏️ edit src/x.ts</details>',
    )
    expect(html.startsWith('<details><summary>')).toBe(true)
    expect(html).not.toContain('<details open')
    expect(html).not.toContain(' open>')
  })

  it('nests a <details> per tool with input and output in separate <pre><code> blocks', () => {
    const html = turnGroupHtml('dev', [
      entry({
        title: 'bash',
        status: 'completed',
        params: 'command=git status',
        output: 'clean tree',
      }),
    ])
    expect(html).toBe(
      '<details><summary>🔧 dev: 1 tool — 🐚 bash @local</summary>' +
        '<details><summary>✓ 🐚 bash @local</summary>' +
        '<pre><code>command=git status</code></pre><pre><code>clean tree</code></pre></details>' +
        '</details>',
    )
    // The tool line is the inner <summary>; input and output are separate blocks.
    expect(html).toContain('<details><summary>✓ 🐚 bash @local</summary><pre><code>command=git status')
    expect(html).toContain('</code></pre><pre><code>clean tree</code></pre>')
    // No icon prefixes on the input/output text.
    expect(html).not.toContain('⚙')
    expect(html).not.toContain('↳')
  })

  it('does not wrap a tool with no input/output in a dead <details>', () => {
    const html = turnGroupHtml('dev', [entry({ title: 'Read file', status: 'completed' })])
    expect(html).toBe(
      '<details><summary>🔧 dev: 1 tool — 📖 Read file</summary>✓ 📖 Read file</details>',
    )
    expect(html.match(/<details>/g)).toHaveLength(1)
  })

  it('separates collapsible tools with a single <br> and no rule', () => {
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
      '<details><summary>🔧 dev: 2 tools — 📖 Read file</summary>' +
        '<details><summary>✓ 🐚 bash @local</summary>' +
        '<pre><code>command=ls</code></pre><pre><code>clean</code></pre></details>' +
        '<br>✓ 📖 Read file</details>',
    )
    expect(html).not.toContain('<hr>')
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
      '<details><summary>🔧 dev: 1 tool — 📖 Read file</summary>• 📖 Read file<br>🗒 plan (2 steps)</details>',
    )
  })

  it('caps a runaway group with a `… K more` line', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      entry({ toolCallId: `tc-${i}`, title: `tool-${i}`, status: 'completed' }),
    )
    const html = turnGroupHtml('dev', many)
    expect(
      html.startsWith(
        '<details><summary>🔧 dev: 25 tools — 🛠 tool-24</summary>… 5 more<br>✓ 🛠 tool-5<br>',
      ),
    ).toBe(true)
    expect(html.endsWith('✓ 🛠 tool-24</details>')).toBe(true)
    expect(html).not.toContain('tool-4')
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

describe('toolEntryPath', () => {
  it('reads the path-ish keys of raw_input, preferring filePath', () => {
    expect(toolEntryPath({ raw_input: { filePath: '/a/b.ts' } })).toBe('/a/b.ts')
    expect(toolEntryPath({ raw_input: { filepath: '/a/b.ts' } })).toBe('/a/b.ts')
    expect(toolEntryPath({ raw_input: { file_path: '/a/b.ts' } })).toBe('/a/b.ts')
    expect(toolEntryPath({ raw_input: { path: '/a/b.ts' } })).toBe('/a/b.ts')
    expect(toolEntryPath({ raw_input: { path: '/a', filePath: '/b' } })).toBe('/b')
  })

  it('falls back to the first locations[].path', () => {
    expect(
      toolEntryPath({ locations: [{ path: '/a/one.ts' }, { path: '/a/two.ts' }] }),
    ).toBe('/a/one.ts')
    expect(toolEntryPath({ raw_input: { command: 'ls' }, locations: [{ path: '/a' }] })).toBe(
      '/a',
    )
  })

  it('returns undefined when the tool names no file', () => {
    expect(toolEntryPath({})).toBeUndefined()
    expect(toolEntryPath({ raw_input: { command: 'ls' } })).toBeUndefined()
    expect(toolEntryPath({ raw_input: 'ls' })).toBeUndefined()
    expect(toolEntryPath({ locations: [{ nope: 1 }] })).toBeUndefined()
  })
})

describe('toolEntryMachine', () => {
  it('prefers the ssh-mcp profile, then host/hostname', () => {
    expect(toolEntryMachine({ raw_input: { profile: 'coolify', host: 'x' } })).toBe('coolify')
    expect(toolEntryMachine({ raw_input: { host: 'router.local' } })).toBe('router.local')
    expect(toolEntryMachine({ raw_input: { hostname: 'pve' } })).toBe('pve')
  })

  it('returns undefined when the event names no machine', () => {
    expect(toolEntryMachine({})).toBeUndefined()
    expect(toolEntryMachine({ raw_input: { command: 'ls' } })).toBeUndefined()
    expect(toolEntryMachine({ raw_input: 'ls' })).toBeUndefined()
    expect(toolEntryMachine({ raw_input: null })).toBeUndefined()
  })

  it('clamps a long host so it cannot eat the line', () => {
    const machine = toolEntryMachine({ raw_input: { host: 'h'.repeat(200) } })!
    expect(machine).toHaveLength(40)
  })
})

describe('toolEntryLine', () => {
  const entry = (over: Partial<TurnToolEntry>): TurnToolEntry => ({
    toolCallId: 'tc-1',
    title: 'bash',
    ...over,
  })

  it('renders a completed tool as ✓ <icon> <title> — no status word', () => {
    expect(toolEntryLine(entry({ status: 'completed' }))).toBe('✓ 🐚 bash @local')
  })

  it('renders an in-flight tool with a ⏳ glyph and no label', () => {
    expect(toolEntryLine(entry({ title: 'edit src/x.ts', status: 'in_progress' }))).toBe(
      '⏳ ✏️ edit src/x.ts',
    )
  })

  it('renders a failed tool as ✗ <icon> <title> — no status word', () => {
    expect(toolEntryLine(entry({ title: 'edit', status: 'failed' }))).toBe('✗ ✏️ edit')
  })

  it('renders a statusless tool with a neutral glyph', () => {
    expect(toolEntryLine(entry({ title: 'Read file' }))).toBe('• 📖 Read file')
  })

  it('shows the file path instead of the tool word for read/write tools', () => {
    expect(
      toolEntryLine(
        entry({ title: 'read /workspace/AGENTS.md', status: 'completed', path: '/workspace/AGENTS.md' }),
      ),
    ).toBe('✓ 📖 /workspace/AGENTS.md')
    expect(toolEntryLine(entry({ title: 'write', status: 'completed', path: '/workspace/src/x.ts' }))).toBe(
      '✓ ✏️ /workspace/src/x.ts',
    )
  })

  it('keeps the title for a path-bearing tool that named no file', () => {
    expect(toolEntryLine(entry({ title: 'Read file' }))).toBe('• 📖 Read file')
  })

  it('never shows a path for a tool that is not a reader or writer', () => {
    expect(toolEntryLine(entry({ title: 'grep', path: '/a' }))).toBe('• 🔍 grep')
  })

  it('names the machine of a remote shell call, or local for a container one', () => {
    expect(toolEntryLine(entry({ title: 'ssh_run-command', machine: 'coolify' }))).toBe(
      '• 🐚 ssh_run-command @coolify',
    )
    expect(toolEntryLine(entry({ title: 'bash' }))).toBe('• 🐚 bash @local')
    expect(toolEntryLine(entry({ title: 'bash', machine: 'hass' }))).toBe('• 🐚 bash @hass')
    expect(toolEntryLine(entry({ title: 'Verify' }))).toBe('• 🛠 Verify')
  })

  it('keeps the machine on the line even when a long title is clamped', () => {
    const line = toolEntryLine(
      entry({ title: `bash ${'x'.repeat(400)}`, status: 'completed' }),
    )
    expect(line.endsWith('… @local')).toBe(true)
    expect(line.length).toBeLessThanOrEqual(200)
  })

  it('shows only the tagline — never raw tool output', () => {
    const line = toolEntryLine(entry({ status: 'completed', output: 'ok', params: 'command=x' }))
    expect(line).toBe('✓ 🐚 bash @local')
    expect(line).not.toContain('·')
    expect(line).not.toContain('ok')
    expect(line).not.toContain('command=x')
  })
})

describe('toolIcon', () => {
  it('maps common tools to their identifying emoji', () => {
    expect(toolIcon('bash')).toBe('🐚')
    expect(toolIcon('ssh_run-command')).toBe('🐚')
    expect(toolIcon('Read file')).toBe('📖')
    expect(toolIcon('edit src/x.ts')).toBe('✏️')
    expect(toolIcon('Edit file')).toBe('✏️')
    expect(toolIcon('grep')).toBe('🔍')
    expect(toolIcon('glob')).toBe('🗂')
    expect(toolIcon('todowrite')).toBe('📝')
    expect(toolIcon('coolify_get_application')).toBe('☁️')
    expect(toolIcon('github_search_code')).toBe('🐙')
    expect(toolIcon('zooid-context_zooid_send_message')).toBe('💬')
    expect(toolIcon('truenas_create_snapshot')).toBe('💾')
    expect(toolIcon('pocketid_user_list')).toBe('🔑')
    expect(toolIcon('ha_GetDateTime')).toBe('🏠')
  })

  it('falls back to the prefix rule for descriptive titles', () => {
    expect(toolIcon('Reading auth.ts')).toBe('📖')
    expect(toolIcon('Writing notes')).toBe('✏️')
  })

  it('falls back to the generic marker for anything else', () => {
    expect(toolIcon('Verify')).toBe('🛠')
    expect(toolIcon('')).toBe('🛠')
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
    expect(turnMirrorNoticeContent('⏳ 🐚 bash', '$root')).toEqual({
      msgtype: 'm.notice',
      body: '⏳ 🐚 bash',
      'dev.zooid.mirror': true,
      'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
    })
  })

  it('adds the HTML format and formatted_body when a formatted body is given', () => {
    expect(turnMirrorNoticeContent('🔧 dev: ⏳ 🐚 bash\n✓ ✏️ edit', '$root', '🔧 dev: ⏳ 🐚 bash<br>✓ ✏️ edit')).toEqual(
      {
        msgtype: 'm.notice',
        body: '🔧 dev: ⏳ 🐚 bash\n✓ ✏️ edit',
        format: 'org.matrix.custom.html',
        formatted_body: '🔧 dev: ⏳ 🐚 bash<br>✓ ✏️ edit',
        'dev.zooid.mirror': true,
        'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
      },
    )
  })
})

describe('turnMirrorEditContent', () => {
  it('is an m.replace of the original, with the thread relation in m.new_content', () => {
    expect(turnMirrorEditContent('$notice', '✓ 🐚 bash @local', '$root')).toEqual({
      msgtype: 'm.notice',
      body: '* ✓ 🐚 bash @local',
      'dev.zooid.mirror': true,
      'm.new_content': {
        msgtype: 'm.notice',
        body: '✓ 🐚 bash @local',
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
        '🔧 dev: ⏳ 🐚 bash\n✓ ✏️ edit',
        '$root',
        '🔧 dev: ⏳ 🐚 bash<br>✓ ✏️ edit',
      ),
    ).toEqual({
      msgtype: 'm.notice',
      body: '* 🔧 dev: ⏳ 🐚 bash\n✓ ✏️ edit',
      format: 'org.matrix.custom.html',
      formatted_body: '* 🔧 dev: ⏳ 🐚 bash<br>✓ ✏️ edit',
      'dev.zooid.mirror': true,
      'm.new_content': {
        msgtype: 'm.notice',
        body: '🔧 dev: ⏳ 🐚 bash\n✓ ✏️ edit',
        format: 'org.matrix.custom.html',
        formatted_body: '🔧 dev: ⏳ 🐚 bash<br>✓ ✏️ edit',
        'dev.zooid.mirror': true,
        'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
      },
      'm.relates_to': { rel_type: 'm.replace', event_id: '$notice' },
    })
  })
})

describe('tool diff rendering', () => {
  const entry = (over: Partial<TurnToolEntry>): TurnToolEntry => ({
    toolCallId: 'tc-1',
    title: 'edit src/x.ts',
    status: 'completed',
    path: '/w/src/x.ts',
    ...over,
  })
  const diff = ['--- a/src/x.ts', '+++ b/src/x.ts', '@@ -1 +1 @@', '-a', '+b'].join('\n')

  it('renders the change in the plain body as a unified diff, keeping the params the diff omits', () => {
    // upsertGroupEntry filters the diff's own keys out of `params` before the
    // entry is built, so what reaches the renderer is the remainder.
    const body = turnGroupBody('dev', [
      entry({ params: 'filePath=src/x.ts, replace_all=false', diff }),
    ])
    expect(body).toContain('@@ -1 +1 @@')
    expect(body).toContain('-a\n+b')
    expect(body).toContain('filePath=src/x.ts, replace_all=false')
    expect(body).not.toContain('oldString=')
  })

  it('renders the change in the HTML body as a language-diff code block', () => {
    const html = turnGroupHtml('dev', [entry({ diff })])
    expect(html).toContain('<pre><code class="language-diff">')
    expect(html).toContain('@@ -1 +1 @@')
    // Escaped, and the block stays a diff — no params block in its place.
    expect(html).not.toContain('oldString=')
    expect(html).not.toContain('<pre><code>filePath=')
  })

  it('escapes HTML in the diff block', () => {
    const html = turnGroupHtml('dev', [
      entry({ diff: ['--- a/f', '+++ b/f', '@@ -1 +1 @@', '-<script>alert(1)</script>', '+a & b'].join('\n') }),
    ])
    expect(html).toContain('-&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('+a &amp; b')
    expect(html).not.toContain('<script>')
  })

  it('keeps the tagline summary and the marker line unchanged', () => {
    const body = turnGroupBody('dev', [entry({ diff })])
    expect(body.split('\n')[0]).toBe('🔧 dev: 1 tool — ✏️ /w/src/x.ts')
    expect(body.split('\n')[1]).toBe('✓ ✏️ /w/src/x.ts')
    expect(turnGroupHtml('dev', [entry({ diff })])).toContain(
      '<summary>🔧 dev: 1 tool — ✏️ /w/src/x.ts</summary>',
    )
  })

  it('still shows output after a diff, separated by the rule', () => {
    const html = turnGroupHtml('dev', [entry({ diff, output: 'applied' })])
    expect(html).toContain('class="language-diff"')
    expect(html).toContain('<pre><code>applied</code></pre>')
    expect(turnGroupBody('dev', [entry({ diff, output: 'applied' })])).toContain(
      '────────────────',
    )
  })

  it('falls back to params when the entry has no diff', () => {
    const html = turnGroupHtml('dev', [entry({ title: 'bash', params: 'command=ls' })])
    expect(html).toContain('<pre><code>command=ls</code></pre>')
    expect(html).not.toContain('language-diff')
  })
})
