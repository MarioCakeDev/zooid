#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildContextMcpServer, registerTaskTools } from './mcp-server.js'
import { callDaemon } from './daemon-socket.js'
import type {
  StartTasksOutput,
  CompleteTaskOutput,
  TaskActions,
  TaskRole,
  TransportContextProvider,
  HandoffOutput,
} from '@zooid/core'

const spawnIdIdx = process.argv.indexOf('--spawn-id')
const spawnId = spawnIdIdx >= 0 ? process.argv[spawnIdIdx + 1] : undefined
const sockPath = process.env.ZOOID_DAEMON_SOCK
if (!spawnId || !sockPath) {
  process.stderr.write('zooid-context-mcp: --spawn-id and ZOOID_DAEMON_SOCK are required\n')
  process.exit(2)
}
process.stderr.write(
  `zooid-context-mcp: starting (pid=${process.pid} spawnId=${spawnId} sock=${sockPath})\n`,
)

const remoteProvider: TransportContextProvider = {
  getRoomHistory: (_channelId, opts) =>
    callDaemon(sockPath, {
      spawnId,
      method: 'getRoomHistory',
      params: (opts ?? {}) as Record<string, unknown>,
    }) as Promise<Awaited<ReturnType<TransportContextProvider['getRoomHistory']>>>,
  getRecentThreads: (_channelId, opts) =>
    callDaemon(sockPath, {
      spawnId,
      method: 'getRecentThreads',
      params: (opts ?? {}) as Record<string, unknown>,
    }) as Promise<Awaited<ReturnType<TransportContextProvider['getRecentThreads']>>>,
  getThreadHistory: (_channelId, threadId, opts) =>
    callDaemon(sockPath, {
      spawnId,
      method: 'getThreadHistory',
      params: { ...(opts ?? {}), threadId } as Record<string, unknown>,
    }) as Promise<Awaited<ReturnType<TransportContextProvider['getThreadHistory']>>>,
  getChannelMembers: () =>
    callDaemon(sockPath, {
      spawnId,
      method: 'getChannelMembers',
      params: {},
    }) as Promise<Awaited<ReturnType<TransportContextProvider['getChannelMembers']>>>,
  getRoomInfo: () =>
    callDaemon(sockPath, {
      spawnId,
      method: 'getRoomInfo',
      params: {},
    }) as Promise<Awaited<ReturnType<TransportContextProvider['getRoomInfo']>>>,
  getRooms: () =>
    callDaemon(sockPath, {
      spawnId,
      method: 'getRooms',
      params: {},
    }) as Promise<Awaited<ReturnType<TransportContextProvider['getRooms']>>>,
  sendMessage: (input) =>
    callDaemon(sockPath, {
      spawnId,
      method: 'sendMessage',
      params: input as unknown as Record<string, unknown>,
    }) as Promise<Awaited<ReturnType<TransportContextProvider['sendMessage']>>>,
}

const remoteTasks: TaskActions = {
  startTasks: (_caller, input) =>
    callDaemon(sockPath, {
      spawnId,
      method: 'startTasks',
      params: input as unknown as Record<string, unknown>,
    }) as Promise<StartTasksOutput>,
  completeTask: (_caller, input) =>
    callDaemon(sockPath, {
      spawnId,
      method: 'completeTask',
      params: input as unknown as Record<string, unknown>,
    }) as Promise<CompleteTaskOutput>,
  describeRole: () =>
    callDaemon(sockPath, {
      spawnId,
      method: 'describeRole',
      params: {},
    }) as Promise<TaskRole>,
  handoff: (_caller, input) =>
    callDaemon(sockPath, {
      spawnId,
      method: 'handoff',
      params: input as unknown as Record<string, unknown>,
    }) as Promise<HandoffOutput>,
}

// Connect the MCP transport before anything else so the read tools are live
// immediately; a cold or slow daemon socket must not fail the agent's first
// tool call with `Not connected` ([[ZOD084]]).
const server = buildContextMcpServer({
  resolve: async () => remoteProvider,
  resolveTasks: async () => remoteTasks,
})
await server.connect(new StdioServerTransport())
process.stderr.write(`zooid-context-mcp: ready (spawnId=${spawnId})\n`)

// Advertise the task tools unconditionally. The daemon is the authorization
// boundary and refuses every disallowed task call per request (`depth_limit`,
// `no_open_task`, `unknown_caller`, `self`, `already_open`), so the MCP does
// not pre-screen. Gating registration on a one-shot `describeRole` snapshot
// taken at spawn meant a single raced or failed role query hid
// `zooid_start_task_threads` for the whole MCP lifetime — the snapshot was
// never refreshed, so the session stayed without the tool even after the
// daemon would have allowed it ([[ZOD084]]).
registerTaskTools(server, {
  resolveTasks: async () => remoteTasks,
  role: { is_task_assignee: true, can_start_task_threads: true, can_handoff: true },
})
