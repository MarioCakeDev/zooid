// Minimal ACP agent for the thread-isolation test.
//
// Deliberately dependency-free: it speaks the newline-delimited JSON-RPC that
// `ndJsonStream` produces, so the probe runs as a plain `node` process without
// any package resolution or TypeScript loader.
//
// For every `session/new` it appends the exact `mcpServers` array it was handed
// to $RECORD_FILE (one JSON line per session, tagged with its pid). That array
// is the session's per-spawn tool catalog as the harness sees it — the thing
// the isolation test asserts on.
import { appendFileSync } from 'node:fs'

const recordFile = process.env.RECORD_FILE
let sessionCounter = 0
let pending = ''

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function handle(frame) {
  // A notification has no id and gets no response (e.g. session/cancel).
  if (frame.id === undefined) return
  switch (frame.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: frame.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            // The daemon's reaper only kills a process that still holds a live
            // session when the adapter can bring it back; the probe can.
            loadSession: true,
            sessionCapabilities: { close: {}, resume: {} },
          },
          agentInfo: { name: 'thread-probe', title: 'Thread probe', version: '0.0.0' },
          authMethods: [],
        },
      })
      return
    case 'session/new': {
      sessionCounter += 1
      const sessionId = `probe-${process.pid}-${sessionCounter}`
      if (recordFile) {
        appendFileSync(
          recordFile,
          JSON.stringify({
            pid: process.pid,
            sessionId,
            mcpServers: frame.params?.mcpServers ?? [],
          }) + '\n',
        )
      }
      send({ jsonrpc: '2.0', id: frame.id, result: { sessionId } })
      return
    }
    case 'session/prompt':
      send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
      return
    case 'session/close':
    case 'session/load':
    case 'session/resume':
      send({ jsonrpc: '2.0', id: frame.id, result: {} })
      return
    default:
      send({ jsonrpc: '2.0', id: frame.id, result: {} })
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  pending += chunk
  let index
  while ((index = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, index).trim()
    pending = pending.slice(index + 1)
    if (line) handle(JSON.parse(line))
  }
})
