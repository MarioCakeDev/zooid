import type { TransportContextProvider, ThreadRef } from '@zooid/core'

/**
 * Daemon-internal record keyed by spawn-id. One per ACP session that has
 * a TransportContextProvider attached.
 */
export interface SpawnBinding {
  spawnId: string
  agentName: string
  threadRef: ThreadRef
  provider: TransportContextProvider
  /** Exact ACP session key; the thread reference remains the context root. */
  sessionKey?: string
}

/**
 * Shape we pass into ACP `session/new mcpServers[]`.
 *
 * `name` is unique per spawn (`zooid-context-<spawnId>`): opencode registers ACP
 * MCP servers in a directory-scoped registry keyed by name, so two concurrent
 * sessions of one agent that shared the name would have the later registration
 * take over the first, routing the first session's tool calls to the other
 * session's process. A per-spawn name keeps each session's server distinct.
 */
export interface ZooidContextServerSpec {
  name: string
  command: string
  args: string[]
  env: Array<{ name: string; value: string }>
}
