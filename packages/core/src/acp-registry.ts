import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  AcpClient,
  resolvePreset,
  type AgentEvent,
  type ApprovalDecision,
  type ApprovalRequest,
  type PromptInput,
  type PromptResult,
  type TapEvent,
  type AcpClientTimeouts,
  isSessionWedge,
} from '@zooid/acp-client'
import type { AcpAgentSpec, AcpMount, AcpRuntime } from './acp-types.js'
import type { AgentConfig } from './types.js'
import type { ApprovalCorrelator, RegisteredApproval } from './approval-correlator.js'

export type AcpRegistryEventHandler = (agentName: string, event: AgentEvent) => void
export type AcpRegistryApprovalHandler = (
  agentName: string,
  req: ApprovalRequest,
) => Promise<ApprovalDecision>

/**
 * Daemon-side surface of the ACP agent fleet. The transport (HTTP) consumes
 * this; the CLI builds it via `buildAcpRegistry`. Long-lived: one
 * `AcpClient` per agent, kept alive across prompts.
 */
export interface AcpRegistry {
  hasAgent(name: string): boolean
  /** Whether an agent has a transport-context provider attached. */
  hasContextSpawn(name: string): boolean
  /** Per-agent approval timeout from zooid.yaml. 0 means no timeout. */
  getApprovalTimeoutMs(name: string): number
  ensureSession(
    name: string,
    threadId: string,
    channelId?: string,
    contextThreadId?: string,
  ): Promise<string>
  /** Drop the in-memory session for (agent, threadId). Next prompt re-creates one. */
  endSession(name: string, threadId: string): void
  prompt(name: string, input: PromptInput): Promise<PromptResult>
  /**
   * Cancel an in-flight prompt for (agent, sessionId). Sends `session/cancel`
   * via the underlying AcpClient and resolves any pending approvals with
   * `decision: 'cancel'`. Idempotent.
   */
  cancelSession(name: string, sessionId: string): Promise<void>
  stopAll(): Promise<void>
  /** Set by the transport. Receives every ACP event from any agent. */
  onEvent: AcpRegistryEventHandler
  /** Set by the transport. Resolves permission requests. */
  onApprovalRequest: AcpRegistryApprovalHandler
  /**
   * Optional. Set by the transport to learn that a prompt moved onto a new ACP
   * session because the previous one wedged, so per-session state can be
   * re-keyed before the replayed turn's events arrive.
   */
  onSessionRekey?: (
    agentName: string,
    threadId: string,
    prevSessionId: string,
    nextSessionId: string,
  ) => void
}

export interface AcpAgentRegistryOptions {
  runtime: AcpRuntime
  agents: Record<string, AgentConfig>
  /** Per-agent env passed to each `AcpClient`'s spawn spec. */
  env?: Record<string, Record<string, string>>
  /** Per-agent container image. Used by DockerAcpRuntime; ignored by LocalAcpRuntime. */
  image?: Record<string, string | undefined>
  /** Initial event handler (the transport may overwrite at app creation). */
  onEvent?: AcpRegistryEventHandler
  /** Initial approval handler (the transport may overwrite at app creation). */
  onApprovalRequest?: AcpRegistryApprovalHandler
  /**
   * Optional correlator: when set, the registry's default
   * `onApprovalRequest` registers each request on the correlator (with the
   * agent's `approval_timeout_ms`) and returns the registered handle's
   * `decisionPromise`. Transports listen on the correlator's `'registered'`
   * + `'timeout'` events to drive the SSE wire and accept HTTP decisions.
   */
  approvals?: ApprovalCorrelator
  /** Called whenever the correlator-backed handler registers an approval. */
  onApprovalRegistered?: (approval: RegisteredApproval) => void
  /**
   * Optional observability tap. Forwarded to each AcpClient so the
   * unfiltered ACP protocol stream + turn-boundary events are visible to
   * the host (e.g. the dev CLI capturing them to disk).
   */
  onTap?: (agentName: string, event: TapEvent) => void
  /**
   * Root directory under which each agent gets a per-agent state dir
   * (`<agentsDir>/<agentName>/`). Used by the AcpClient session store to
   * persist ACP `sessionId`s across daemon restarts. Optional: when unset,
   * session continuity across restarts is disabled.
   */
  agentsDir?: string
  /**
   * Per-agent factory that returns a `mcpServers[]` entry for the
   * `zooid-context` MCP server. Forwarded to each AcpClient. Agents bound to
   * transports without a context provider (e.g. HTTP) have no entry here.
   */
  contextSpawns?: Record<string, ContextSpawnFactory | undefined>
  /**
   * Per-agent resolved bind-mount list. Threaded into the AcpClient's spawn
   * spec; honoured by the docker runtime, ignored by the local runtime.
   */
  mounts?: Record<string, AcpMount[]>
  /**
   * Per-agent list of host directories to `mkdir -p` before the first
   * `runtime.spawn` for that agent. Subset of mount entries with `create: true`.
   */
  mkdirOnSpawn?: Record<string, string[]>
  /**
   * Per-agent override for the spawn-spec `cwd`. Set to e.g. `/workspace`
   * when the workspace mount is active; falls back to `agent.workdir`.
   */
  cwd?: Record<string, string>
  /**
   * Called after an ACP session is created or recovered.  Context adapters
   * which cannot receive an MCP spawn id (Pi) use this to resolve their
   * daemon-side binding by the ACP session id instead.
   */
  onSessionEstablished?: (agentName: string, sessionKey: string, sessionId: string) => void
  /**
   * Handshake deadlines forwarded to each `AcpClient`. Bounds `initialize`
   * and `loadSession`/`newSession` so a dead/recreated agent container fails
   * the dispatch instead of hanging the daemon.
   */
  timeouts?: AcpClientTimeouts
  /**
   * How many times a single prompt may be attempted against an agent. The
   * first attempt is the original dispatch; `2` (the default) means exactly one
   * replay after a wedged session. Bounded on purpose: the same prompt must
   * never be replayed indefinitely, which is how an unguarded re-arm turned a
   * session wedge into a reconnect loop.
   */
  maxPromptAttempts?: number
  /**
   * Called when a prompt had to be moved onto a new ACP session because the
   * previous one never answered. Transports key per-session state (stream
   * registries, buffers, thread context) by session id, so they need this to
   * re-key before the replayed turn's events arrive. Fired *before* the
   * `session_wedge` event.
   */
  onSessionRekey?: (
    agentName: string,
    threadId: string,
    prevSessionId: string,
    nextSessionId: string,
  ) => void
}

/**
 * Original dispatch + one replay. A wedge is a rare, structural failure — if
 * the replacement session also wedges, something is wrong with the agent
 * itself and replaying again only burns CPU.
 */
const DEFAULT_MAX_PROMPT_ATTEMPTS = 2

export type ContextSpawnFactory = (
  threadId: string,
  channelId?: string,
  sessionKey?: string,
) => Promise<{
  name: 'zooid-context'
  command: string
  args: string[]
  env: Array<{ name: string; value: string }>
}>

export class AcpAgentRegistry implements AcpRegistry {
  readonly opts: AcpAgentRegistryOptions
  private readonly clients = new Map<string, AcpClient>()
  /** In-flight first-time starts, keyed by agent, so concurrent dispatches
   *  don't spawn duplicate children/containers for the same agent. */
  private readonly starting = new Map<string, Promise<AcpClient>>()

  onEvent: AcpRegistryEventHandler
  onApprovalRequest: AcpRegistryApprovalHandler
  onSessionRekey?: AcpAgentRegistryOptions['onSessionRekey']

  constructor(opts: AcpAgentRegistryOptions) {
    this.opts = opts
    this.onSessionRekey = opts.onSessionRekey
    this.onEvent = opts.onEvent ?? (() => {})
    if (opts.onApprovalRequest) {
      this.onApprovalRequest = opts.onApprovalRequest
    } else if (opts.approvals) {
      const correlator = opts.approvals
      this.onApprovalRequest = async (name, req) => {
        const cfg = this.opts.agents[name]
        const handle = correlator.register(name, req.sessionId, req, {
          timeoutMs: cfg?.approval_timeout_ms ?? 0,
        })
        this.opts.onApprovalRegistered?.(handle)
        return handle.decisionPromise
      }
    } else {
      this.onApprovalRequest = async () => ({ decision: 'cancel' })
    }
  }

  hasAgent(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.opts.agents, name)
  }

  hasContextSpawn(name: string): boolean {
    return Boolean(this.opts.contextSpawns?.[name])
  }

  resolveSpawnEnv(name: string): Record<string, string> {
    return this.opts.env?.[name] ?? {}
  }

  resolveSpawnImage(name: string): string | undefined {
    return this.opts.image?.[name]
  }

  resolveSpawnMounts(name: string): AcpMount[] {
    return this.opts.mounts?.[name] ?? []
  }

  resolveSpawnCwd(name: string): string {
    return this.opts.cwd?.[name] ?? this.opts.agents[name]?.workdir ?? process.cwd()
  }

  agentNames(): string[] {
    return Object.keys(this.opts.agents)
  }

  getApprovalTimeoutMs(name: string): number {
    return this.opts.agents[name]?.approval_timeout_ms ?? 0
  }

  async ensureSession(
    name: string,
    threadId: string,
    channelId?: string,
    contextThreadId?: string,
  ): Promise<string> {
    if (!this.hasAgent(name)) throw new Error(`unknown agent: ${name}`)
    const client = await this.ensureClient(name)
    const sessionId = await client.ensureSession(threadId, channelId, contextThreadId)
    this.opts.onSessionEstablished?.(name, threadId, sessionId)
    return sessionId
  }

  endSession(name: string, threadId: string): void {
    if (!this.hasAgent(name)) return
    const client = this.clients.get(name)
    client?.endSession(threadId)
  }

  async cancelSession(name: string, sessionId: string): Promise<void> {
    if (!this.hasAgent(name)) return
    const client = this.clients.get(name)
    // Always nudge the correlator first so any pending approvals resolve with
    // 'cancel' regardless of whether the client is alive or already stopped.
    this.opts.approvals?.cancelSession(sessionId)
    if (!client) return
    try {
      await client.cancel(sessionId)
    } catch (err) {
      // ACP cancel is a notification; failures here are typically transport
      // errors after the agent has already exited.
      console.warn(`[acp:${name}] cancel(${sessionId}) failed:`, err)
    }
  }

  /**
   * Dispatch a prompt, recovering once from a wedged session.
   *
   * A session resumed across a daemon restart can accept a prompt and then
   * never answer — the ACP stream carries the notification and nothing comes
   * back. The `AcpClient` detects that (first-response deadline) and throws
   * an `AcpSessionWedgeError` having already invalidated the session and
   * marked itself dead. Here we reconnect, establish a *fresh* session and
   * replay the same prompt, so the owner never has to retype "continue".
   * Bounded by `maxPromptAttempts`; when the budget runs out we surface the
   * wedge (`recovered: false`) and let the error propagate.
   */
  async prompt(name: string, input: PromptInput): Promise<PromptResult> {
    if (!this.hasAgent(name)) throw new Error(`unknown agent: ${name}`)
    const maxAttempts = Math.max(1, this.opts.maxPromptAttempts ?? DEFAULT_MAX_PROMPT_ATTEMPTS)
    let lastErr: unknown
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const client = await this.ensureClient(name)
      try {
        // `prompt()` reports the session it ran on, which after a recovery is
        // the *fresh* one — callers key their per-session state off it.
        return await client.prompt(input)
      } catch (err) {
        if (!isSessionWedge(err)) throw err
        lastErr = err
        const wedged = err.sessionId
        if (attempt >= maxAttempts) {
          console.warn(
            `[acp:${name}] session ${wedged ?? '<none>'} wedged; ` +
              `replay budget exhausted after ${attempt} attempt(s):`,
            err,
          )
          this.onEvent(name, {
            type: 'session_wedge',
            sessionId: wedged,
            recovered: false,
            attempt,
            maxAttempts,
          })
          throw err
        }
        // Fresh client (the wedged one is dead) and a fresh session: the wedged
        // session id was dropped from the store, so `ensureSession` issues
        // session/new rather than resuming the corpse.
        const client2 = await this.ensureClient(name)
        const next = await client2.ensureSession(
          input.threadId,
          input.channelId,
          input.contextThreadId,
        )
        this.opts.onSessionEstablished?.(name, input.threadId, next)
        if (wedged) this.onSessionRekey?.(name, input.threadId, wedged, next)
        console.warn(
          `[acp:${name}] session ${wedged} wedged (no output after prompt); ` +
            `recovered on fresh session ${next}; replaying prompt (attempt ${attempt + 1}/${maxAttempts})`,
        )
        this.onEvent(name, {
          type: 'session_wedge',
          sessionId: wedged,
          recovered: true,
          attempt,
          maxAttempts,
          recoveredSessionId: next,
        })
      }
    }
    throw lastErr
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.clients.values()].map((c) => c.stop()))
    this.clients.clear()
  }

  /** Registry-wide deadlines, with this agent's first-response override applied. */
  private resolveTimeouts(name: string): AcpClientTimeouts | undefined {
    const base = this.opts.timeouts
    const override = this.opts.agents[name]?.first_response_timeout_ms
    if (!base && override === undefined) return undefined
    return { ...base, firstResponseMs: override ?? base?.firstResponseMs }
  }

  private async ensureClient(name: string): Promise<AcpClient> {
    const existing = this.clients.get(name)
    if (existing) {
      // A client whose child/container was recreated underneath the daemon
      // reports itself dead. Never return it: drop the stale handle and
      // reconnect, otherwise every later mention blocks on a dead connection.
      if (existing.isAlive()) return existing
      this.clients.delete(name)
      console.warn(`[acp:${name}] cached client is dead; reconnecting`)
      void existing.stop().catch((err) => {
        console.warn(`[acp:${name}] stop() of dead client failed:`, err)
      })
    }
    const inFlight = this.starting.get(name)
    if (inFlight) return inFlight
    const starting = this.startClient(name)
    this.starting.set(name, starting)
    try {
      return await starting
    } finally {
      this.starting.delete(name)
    }
  }

  private async startClient(name: string): Promise<AcpClient> {
    const cfg = this.opts.agents[name]
    if (!cfg.acp) throw new Error(`agents.${name}: missing acp block`)
    const spawn = resolveAcpAgentSpec(cfg.acp)
    for (const dir of this.opts.mkdirOnSpawn?.[name] ?? []) {
      mkdirSync(dir, { recursive: true })
    }
    const client = new AcpClient({
      agent: {
        id: name,
        command: spawn.command,
        args: spawn.args,
        env: this.opts.env?.[name],
        cwd: this.resolveSpawnCwd(name),
        image: this.opts.image?.[name],
        mounts: this.resolveSpawnMounts(name),
      },
      agentDataDir: this.opts.agentsDir ? join(this.opts.agentsDir, name) : undefined,
      runtime: this.opts.runtime,
      onEvent: (e) => this.onEvent(name, e),
      onApprovalRequest: (req) => this.onApprovalRequest(name, req),
      onTap: this.opts.onTap ? (e) => this.opts.onTap!(name, e) : undefined,
      contextSpawn: this.opts.contextSpawns?.[name],
      timeouts: this.resolveTimeouts(name),
    })
    try {
      await client.start()
    } catch (err) {
      // Don't leak a half-started child when the handshake fails/times out.
      void client.stop().catch(() => {})
      throw err
    }
    this.clients.set(name, client)
    return client
  }
}

export function resolveAcpAgentSpec(spec: AcpAgentSpec): {
  command: string
  args: string[]
} {
  if ('preset' in spec && spec.preset) {
    return resolvePreset(spec.preset, { model: spec.model })
  }
  if ('command' in spec && spec.command) {
    return { command: spec.command, args: spec.args ?? [] }
  }
  throw new Error('AcpAgentSpec: must specify either preset or command')
}
