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
  createsTurnLine,
  toolStatusLabel,
  toolEntryLine,
  toolSummaryDetail,
  renderTurnDetails,
  turnWorkingBody,
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
  it('announces an approval request with the id and both interactive replies', () => {
    const body = toActivityNoticeBody('dev.zooid.approval_request', {
      approval_id: 'a1b2',
      tool_call_id: 'tc-1',
      tool_title: 'git push',
      options: [],
    })
    expect(body).toContain('🔐 Approval needed: git push (id a1b2)')
    expect(body).toContain('approve a1b2')
    expect(body).toContain('deny a1b2')
    expect(body).toContain('✅')
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

describe('turnWorkingBody', () => {
  it('starts as a working line', () => {
    expect(turnWorkingBody('architect', 'working…')).toBe('🔧 architect: working…')
  })

  it('shows the latest activity — a tool title with its status label', () => {
    expect(turnWorkingBody('architect', 'bash — running')).toBe('🔧 architect: bash — running')
    expect(turnWorkingBody('architect', 'edit src/x.ts')).toBe('🔧 architect: edit src/x.ts')
  })

  it('clamps to one line', () => {
    const body = turnWorkingBody('architect', 'x'.repeat(1000))
    expect(body.length).toBe(400)
    expect(body.endsWith('…')).toBe(true)
    expect(body).not.toContain('\n')
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

describe('toolSummaryDetail', () => {
  it('uses the title alone when the status is unknown', () => {
    expect(toolSummaryDetail({ toolCallId: 'tc-1', title: 'edit src/x.ts' })).toBe(
      'edit src/x.ts',
    )
  })

  it('appends the human status label', () => {
    expect(toolSummaryDetail({ toolCallId: 'tc-1', title: 'bash', status: 'in_progress' })).toBe(
      'bash — running',
    )
    expect(toolSummaryDetail({ toolCallId: 'tc-1', title: 'bash', status: 'completed' })).toBe(
      'bash — done',
    )
  })
})

describe('renderTurnDetails', () => {
  it('is a collapsed <details> whose first child is <summary>', () => {
    const html = renderTurnDetails('🔧 dev: bash — running', [
      { toolCallId: 'tc-1', title: 'bash', status: 'in_progress' },
    ])
    expect(html.startsWith('<details><summary>')).toBe(true)
    expect(html).not.toContain('open')
    expect(html).toContain('<summary>🔧 dev: bash — running</summary>')
    expect(html).toContain('⏳ bash')
    expect(html.endsWith('</details>')).toBe(true)
  })

  it('lists tools in first-seen order, one line each', () => {
    const html = renderTurnDetails('🔧 dev: edit', [
      { toolCallId: 'tc-1', title: 'bash', status: 'completed' },
      { toolCallId: 'tc-2', title: 'edit', status: 'failed' },
    ])
    expect(html.indexOf('✓ bash — done')).toBeLessThan(html.indexOf('✗ edit — failed'))
    expect(html).toContain('✓ bash — done<br>✗ edit — failed')
  })

  it('escapes HTML-special characters in titles and summary', () => {
    const html = renderTurnDetails('🔧 dev: <x>', [
      { toolCallId: 'tc-1', title: 'a <b> & c', status: 'completed' },
    ])
    expect(html).toContain('&lt;x&gt;')
    expect(html).toContain('a &lt;b&gt; &amp; c')
    expect(html).not.toContain('<b>')
  })

  it('still renders a valid empty block when no tool has run yet (plan-only line)', () => {
    expect(renderTurnDetails('🔧 dev: plan (2 steps)', [])).toBe(
      '<details><summary>🔧 dev: plan (2 steps)</summary></details>',
    )
  })
})

describe('createsTurnLine', () => {
  it('is true for tool activity and a plan update', () => {
    expect(createsTurnLine('dev.zooid.tool_call')).toBe(true)
    expect(createsTurnLine('dev.zooid.tool_call_update')).toBe(true)
    expect(createsTurnLine('dev.zooid.plan')).toBe(true)
  })

  it('is false for available_commands and everything else', () => {
    expect(createsTurnLine('dev.zooid.available_commands_update')).toBe(false)
    expect(createsTurnLine('dev.zooid.error')).toBe(false)
    expect(createsTurnLine('dev.zooid.turn.end')).toBe(false)
    expect(createsTurnLine('dev.zooid.unknown')).toBe(false)
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
  it('is a threaded m.notice carrying the marker, a plain summary and HTML details', () => {
    const details = '<details><summary>🔧 architect: bash — running</summary>⏳ bash</details>'
    expect(turnMirrorNoticeContent('🔧 architect: bash — running', details, '$root')).toEqual({
      msgtype: 'm.notice',
      body: '🔧 architect: bash — running',
      format: 'org.matrix.custom.html',
      formatted_body: details,
      'dev.zooid.mirror': true,
      'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
    })
  })
})

describe('turnMirrorEditContent', () => {
  it('is an m.replace of the original, with the thread relation in m.new_content', () => {
    const details = '<details><summary>✅ dev: done · 1 tool · 0 files</summary>✓ bash — done</details>'
    expect(
      turnMirrorEditContent('$notice', '✅ dev: done · 1 tool · 0 files', details, '$root'),
    ).toEqual({
      msgtype: 'm.notice',
      body: '* ✅ dev: done · 1 tool · 0 files',
      format: 'org.matrix.custom.html',
      formatted_body: details,
      'dev.zooid.mirror': true,
      'm.new_content': {
        msgtype: 'm.notice',
        body: '✅ dev: done · 1 tool · 0 files',
        format: 'org.matrix.custom.html',
        formatted_body: details,
        'dev.zooid.mirror': true,
        'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
      },
      'm.relates_to': { rel_type: 'm.replace', event_id: '$notice' },
    })
  })
})
