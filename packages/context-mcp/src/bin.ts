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
}

// Connect the MCP transport BEFORE the daemon role query. The old order
// awaited a daemon round-trip first, so on a cold session (daemon recreating,
// socket slow) the agent's first tool call reached the SDK before the transport
// was up and failed with `Not connected` — only a manual retry worked. The
// query is additive: the read tools are live immediately, and an allowed role
// adds the task tools afterwards.
const server = buildContextMcpServer({
  resolve: async () => remoteProvider,
  resolveTasks: async () => remoteTasks,
})
await server.connect(new StdioServerTransport())
process.stderr.write(`zooid-context-mcp: ready (spawnId=${spawnId})\n`)

// A failed role query yields undefined, which registers neither task tool —
// the safe direction for MCP: the tools are additive, and a spawn that
// cannot reach the daemon cannot usefully call them anyway ([[ZOD084]]).
// Deliberately not awaited: the stdio transport keeps the process alive, and a
// role query that never settles must not surface as an unsettled top-level
// await (nor delay the read tools that are already live).
void callDaemon(sockPath, { spawnId, method: 'describeRole', params: {} })
  .then((r) => r as TaskRole)
  .catch(() => undefined)
  .then((role) => {
    if (role) registerTaskTools(server, { resolveTasks: async () => remoteTasks, role })
  })
