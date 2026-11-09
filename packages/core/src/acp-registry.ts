import type { ElicitationRequest, ElicitationResponse } from '@zooid/acp-client'
import type { ElicitationCorrelator } from './elicitation-correlator.js'

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  AcpClient,
  JsonFileSessionStore,
  resolvePreset,
  type AgentEvent,
  type ApprovalDecision,
  type ApprovalRequest,
  type PromptInput,
  type PromptResult,
  type SessionStoreLike,
  type TapEvent,
  type AcpClientTimeouts,
  isSessionWedge,
  type SessionLifecycleEvent,
} from '@zooid/acp-client'
import type { AcpAgentSpec, AcpMount, AcpRuntime } from './acp-types.js'
import type { AgentConfig } from './types.js'
import type { ApprovalCorrelator, RegisteredApproval } from './approval-correlator.js'

export type AcpRegistryElicitationHandler = (
  agentName: string,
  req: ElicitationRequest,
  signal: AbortSignal,
) => Promise<ElicitationResponse>

export type AcpRegistryEventHandler = (agentName: string, event: AgentEvent) => void
export type AcpRegistryApprovalHandler = (
  agentName: string,
  req: ApprovalRequest,
) => Promise<ApprovalDecision>

/**
 * Daemon-side surface of the ACP agent fleet. The transport (HTTP) consumes
 * this; the CLI builds it via `buildAcpRegistry`.
 *
 * One ACP process per agent **conversation** (zooid's session key: the thread
 * id for a thread-level turn, a composed `thread|call` key for a handoff arc).
 * The process is reused for that conversation's turns and idle-reaped. That is
 * the containment boundary: an adapter that keeps `session/new` MCP servers in
 * a directory-scoped registry (opencode#40978) can only ever advertise the
 * servers of the one session living in its process, so a foreign session's
 * `zooid-context` server cannot answer a call.
 */
export interface AcpRegistry {
  hasAgent(name: string): boolean
  /** The runtime an agent's ACP process spawns through. [ZOD109] */
  runtimeFor(name: string): AcpRuntime
  /** Whether an agent has a transport-context provider attached. */
  hasContextSpawn(name: string): boolean
  /** Per-agent approval timeout from zooid.yaml. 0 means no timeout. */
  getApprovalTimeoutMs(name: string): number
  /**
   * Establish (or recover) the session for one conversation and return its ACP
   * session id. `threadId` is zooid's session key — the thread root for a
   * thread-level turn, a composed `thread|call` key for a handoff arc — and is
   * also the key the per-conversation process is held under.
   */
  ensureSession(
    name: string,
    threadId: string,
    channelId?: string,
    contextThreadId?: string,
  ): Promise<string>
  /** Close and forget the session for (agent, threadId); the next prompt starts fresh. */
  endSession(name: string, threadId: string): Promise<void>
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
  /** Installed before startup by a transport with a human response surface. */
  onElicitationRequest?: AcpRegistryElicitationHandler
}

export interface AcpAgentRegistryOptions {
  /** Runtime for agents without an entry in `runtimeByAgent`. */
  runtime?: AcpRuntime
  /** Per-agent runtime; wins over `runtime`. Mixed fleets set one per agent. [ZOD109] */
  runtimeByAgent?: Record<string, AcpRuntime>
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
  elicitations?: Pick<ElicitationCorrelator, 'cancelSession'>
  /** Called whenever the correlator-backed handler registers an approval. */
  onApprovalRegistered?: (approval: RegisteredApproval) => void
  /**
   * Optional observability tap. Forwarded to each AcpClient so the
   * unfiltered ACP protocol stream + turn-boundary events are visible to
   * the host (e.g. the dev CLI capturing them to disk).
   */
  onTap?: (agentName: string, event: TapEvent) => void
  onLifecycle?: (agentName: string, event: SessionLifecycleEvent) => void
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
   * Called when an ACP session stops owning its context spawn: it was closed
   * (idle timeout, `/clear`, reset) or superseded by a fresh session. The
   * context spawn registry releases the binding here so a `zooid-context` MCP
   * server left registered in the agent's directory-scoped tool list can no
   * longer act on the dead session's room/thread/task — the daemon answers
   * `binding not owned by caller` instead.
   */
  onSessionEnded?: (agentName: string, sessionKey: string) => void
  /**
   * Handshake deadlines forwarded to each `AcpClient`. Bounds `initialize`
   * and `loadSession`/`newSession` so a dead/recreated agent container fails
   * the dispatch instead of hanging the daemon.
   */
  timeouts?: AcpClientTimeouts
  /**
   * Idle deadline for a per-conversation ACP process, in milliseconds. Once a
   * process has been idle this long — no turn, no pending approval or
   * elicitation — it is closed and reaped, so four agents with a handful of
   * recently-active threads cost a handful of processes, not one per thread
   * ever seen. Per-agent override: `agents.<name>.process_idle_timeout_ms`.
   * `0` disables process reaping. Default 5m.
   */
  processIdleTimeoutMs?: number
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

/**
 * Default idle deadline for a per-conversation ACP process. Deliberately
 * shorter than the 10m session idle close: the expensive thing is the process
 * and its MCP clients, and a reaped process resumes its session (when the
 * adapter supports it) on the next turn.
 */
const DEFAULT_PROCESS_IDLE_TIMEOUT_MS = 300_000

/** A start that dies this soon is a crash, not a normal session end. */
const QUICK_DEATH_MS = 60_000
/** Crash-loop breaker: N quick failures inside the window opens the circuit. */
const CRASH_THRESHOLD = 3
const CRASH_WINDOW_MS = 60_000
const CRASH_COOLDOWN_MS = 30_000
const CRASH_COOLDOWN_MAX_MS = 600_000

/** One live ACP process, bound to exactly one conversation. */
interface ClientEntry {
  client: AcpClient
  agent: string
  sessionKey: string
  startedAt: number
  lastUsed: number
}

interface CrashState {
  /** Timestamps of recent quick failures, within CRASH_WINDOW_MS. */
  failures: number[]
  /** No spawn is attempted before this timestamp. */
  openUntil: number
  /** Current backoff, doubled on every trip up to CRASH_COOLDOWN_MAX_MS. */
  cooldown: number
}

export type ContextSpawnFactory = (
  threadId: string,
  channelId?: string,
  sessionKey?: string,
) => Promise<{
  name: string
  command: string
  args: string[]
  env: Array<{ name: string; value: string }>
}>

export class AcpAgentRegistry implements AcpRegistry {
  readonly opts: AcpAgentRegistryOptions
  /** One live process per (agent, conversation), addressed by agent + session key. */
  private readonly clients = new Map<string, ClientEntry>()
  /** In-flight starts, keyed like `clients`, so concurrent dispatches for the
   *  same conversation don't spawn duplicate children/containers. */
  private readonly starting = new Map<string, Promise<ClientEntry>>()
  /** Processes being torn down; a dispatch for the same conversation waits for
   *  the old child to die instead of racing it onto the same session. */
  private readonly stopping = new Map<string, Promise<void>>()
  /** One shared session store per agent: every conversation's client persists
   *  into the same `sessions.json` instead of clobbering each other's copy. */
  private readonly stores = new Map<string, JsonFileSessionStore>()
  /** Per-conversation crash-loop bookkeeping. */
  private readonly crashes = new Map<string, CrashState>()
  /** Conversations whose context binding has already been released, so the
   *  idle-close lifecycle and our own end/reap paths don't double-release. */
  private readonly released = new Set<string>()
  private reaper: ReturnType<typeof setInterval> | undefined
  private warnedNoReap = false

  onEvent: AcpRegistryEventHandler
  onApprovalRequest: AcpRegistryApprovalHandler
  onSessionRekey?: AcpAgentRegistryOptions['onSessionRekey']
  /** Installed before startup by a transport with a human response surface. */
  onElicitationRequest?: AcpRegistryElicitationHandler

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

  runtimeFor(name: string): AcpRuntime {
    const rt = this.opts.runtimeByAgent?.[name] ?? this.opts.runtime
    if (!rt) throw new Error(`no runtime for agent ${name}`)
    return rt
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
    const entry = await this.ensureClient(name, threadId)
    const sessionId = await entry.client.ensureSession(threadId, channelId, contextThreadId)
    this.touch(entry)
    this.markBound(name, threadId)
    this.opts.onSessionEstablished?.(name, threadId, sessionId)
    return sessionId
  }

  async endSession(name: string, threadId: string): Promise<void> {
    if (!this.hasAgent(name)) return
    const key = this.clientKey(name, threadId)
    const entry = this.clients.get(key)
    this.crashes.delete(key)
    // Remove the entry from dispatch *before* awaiting the close, and publish
    // `stopping[key]` in the same synchronous step (inside retireEntry): a
    // turn arriving mid-/clear must wait for the teardown, never run on the
    // process we are about to kill.
    if (!entry) {
      // The session is forgotten either way (close supported or not), so its
      // context binding must stop being callable.
      this.releaseBinding(name, threadId)
      return
    }
    await this.retireEntry(entry, `session ended (${threadId})`, () =>
      entry.client.endSession(threadId),
    )
  }

  async cancelSession(name: string, sessionId: string): Promise<void> {
    if (!this.hasAgent(name)) return
    // Always nudge the correlator first so any pending approvals resolve with
    // 'cancel' regardless of whether the client is alive or already stopped.
    this.opts.approvals?.cancelSession(sessionId)
    this.opts.elicitations?.cancelSession(sessionId, 'interrupt')
    // The caller knows the ACP session id, not the conversation key; find the
    // one process that owns it (per-conversation processes ⇒ one candidate).
    const entry = [...this.clients.values()].find(
      (e) => e.agent === name && e.client.ownsSession(sessionId),
    )
    if (!entry) return
    this.touch(entry)
    try {
      await entry.client.cancel(sessionId)
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
    const maxAttempts = this.resolveMaxPromptAttempts()
    let entry = await this.ensureClient(name, input.threadId)
    for (let attempt = 1; ; attempt++) {
      try {
        // `prompt()` reports the session it ran on, which after a recovery is
        // the *fresh* one — callers key their per-session state off it.
        const result = await entry.client.prompt(input)
        this.touch(entry)
        return result
      } catch (err) {
        if (!isSessionWedge(err)) throw err
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
        // Retire this conversation's process only. Every other thread keeps its
        // process and session — a wedge is no longer an agent-wide event. The
        // client is already dead; `retireEntry` still fences dispatch behind the
        // teardown and releases the stale context binding.
        console.warn(
          `[acp:${name}] process for ${input.threadId} wedged ` +
            `(session ${wedged ?? '<none>'}); respawning it and replaying`,
        )
        await this.retireEntry(entry, 'wedged', async () => {})
        // Fresh client (the wedged one is dead) and a fresh session: the wedged
        // session id was dropped from the store, so `ensureSession` issues
        // session/new rather than resuming the corpse.
        entry = await this.ensureClient(name, input.threadId)
        const next = await entry.client.ensureSession(
          input.threadId,
          input.channelId,
          input.contextThreadId,
        )
        this.touch(entry)
        this.markBound(name, input.threadId)
        this.opts.onSessionEstablished?.(name, input.threadId, next)
        if (wedged) this.onSessionRekey?.(name, input.threadId, wedged, next)
        console.warn(
          `[acp:${name}] session ${wedged} wedged (no output after prompt); ` +
            `recovered on fresh session ${next}; replaying prompt ` +
            `(attempt ${attempt + 1}/${maxAttempts})`,
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
  }

  /**
   * Replay budget, validated once. `Math.max(1, NaN)` is `NaN`, which would
   * make the attempt loop never run and reject with bare `undefined` — the
   * exact kind of silent-with-no-cause failure this layer exists to prevent.
   */
  private resolveMaxPromptAttempts(): number {
    const raw = this.opts.maxPromptAttempts
    if (raw === undefined) return DEFAULT_MAX_PROMPT_ATTEMPTS
    if (!Number.isInteger(raw) || raw < 1) {
      throw new Error(
        `maxPromptAttempts: must be an integer >= 1 (got ${JSON.stringify(raw)})`,
      )
    }
    return raw
  }

  async stopAll(): Promise<void> {
    if (this.reaper) {
      clearInterval(this.reaper)
      this.reaper = undefined
    }
    const entries = [...this.clients.values()]
    this.clients.clear()
    await Promise.allSettled(entries.map((e) => e.client.stop()))
    this.stopping.clear()
  }

  /**
   * Stop every process that has been idle past its agent's deadline. Public so
   * a test (or an operator command) can sweep deterministically; the daemon
   * drives it from a timer.
   */
  async reapIdle(now: number = Date.now()): Promise<void> {
    const victims: ClientEntry[] = []
    for (const entry of this.clients.values()) {
      const timeout = this.processIdleTimeoutFor(entry.agent)
      if (!timeout || now - entry.lastUsed < timeout) continue
      // Never kill a turn, an approval/elicitation wait or a close in flight.
      if (entry.client.isBusy()) continue
      // Killing a process that still holds a live session is only safe if the
      // adapter can bring it back (session/resume or session/load). Otherwise
      // it would silently drop the conversation's context.
      if (entry.client.hasLiveSessions() && !entry.client.canResumeSessions()) {
        if (!this.warnedNoReap) {
          console.warn(
            '[acp] not reaping idle processes: this adapter cannot resume or load ' +
              'sessions, so a reaped process would drop the conversation',
          )
          this.warnedNoReap = true
        }
        continue
      }
      victims.push(entry)
    }
    await Promise.allSettled(victims.map((entry) => this.reapEntry(entry, 'idle')))
  }

  /** Registry-wide deadlines, with this agent's first-response override applied. */
  private resolveTimeouts(name: string): AcpClientTimeouts | undefined {
    const base = this.opts.timeouts
    const override = this.opts.agents[name]?.first_response_timeout_ms
    if (!base && override === undefined) return undefined
    return { ...base, firstResponseMs: override ?? base?.firstResponseMs }
  }

  private clientKey(agent: string, sessionKey: string): string {
    return `${agent}\u0000${sessionKey}`
  }

  private processIdleTimeoutFor(name: string): number {
    return (
      this.opts.agents[name]?.process_idle_timeout_ms ??
      this.opts.processIdleTimeoutMs ??
      DEFAULT_PROCESS_IDLE_TIMEOUT_MS
    )
  }

  /** One shared store per agent, so per-conversation clients don't clobber
   *  each other's `sessions.json` write. */
  private storeFor(name: string): SessionStoreLike | undefined {
    if (!this.opts.agentsDir) return undefined
    let store = this.stores.get(name)
    if (!store) {
      store = new JsonFileSessionStore({
        agentId: name,
        dir: join(this.opts.agentsDir, name),
      })
      this.stores.set(name, store)
    }
    return store
  }

  private touch(entry: ClientEntry): void {
    entry.lastUsed = Date.now()
    const key = this.clientKey(entry.agent, entry.sessionKey)
    // A process that has stayed up past the quick-death window is healthy:
    // forget its crash history, so one bad image pull doesn't count forever.
    if (this.crashes.has(key) && Date.now() - entry.startedAt >= QUICK_DEATH_MS) {
      this.crashes.delete(key)
    }
  }

  /** A conversation now owns a freshly minted context spawn again. */
  private markBound(agent: string, sessionKey: string): void {
    this.released.delete(this.clientKey(agent, sessionKey))
  }

  /**
   * Release a conversation's context spawn exactly once per session lifetime.
   * Three paths can report the same end — the ACP idle close (`closed`
   * lifecycle), an explicit `endSession`, and the process reaper — and
   * `SpawnRegistry.releaseSession` would otherwise be called two or three
   * times for one binding.
   */
  private releaseBinding(agent: string, sessionKey: string): void {
    const key = this.clientKey(agent, sessionKey)
    if (this.released.has(key)) return
    this.released.add(key)
    this.opts.onSessionEnded?.(agent, sessionKey)
  }

  private async ensureClient(name: string, sessionKey: string): Promise<ClientEntry> {
    const key = this.clientKey(name, sessionKey)
    const existing = this.clients.get(key)
    if (existing) {
      // A child/container recreated underneath the daemon reports itself dead.
      // Never reuse it: drop the handle and respawn for this conversation only.
      if (existing.client.isAlive()) {
        this.touch(existing)
        return existing
      }
      this.clients.delete(key)
      this.recordCrash(key, Date.now() - existing.startedAt, name, sessionKey)
      console.warn(`[acp:${name}] process for ${sessionKey} is dead; respawning`)
      void existing.client.stop().catch((err) => {
        console.warn(`[acp:${name}] stop() of dead process failed:`, err)
      })
    }
    const inFlight = this.starting.get(key)
    if (inFlight) return inFlight
    // A reap/teardown in progress for this conversation must finish before a
    // new process starts, or two processes could touch the same ACP session.
    // Re-enter the whole selection after the wait: a second dispatch queued on
    // the same teardown would otherwise also fall through and start its own
    // process (one orphaned on the same persisted pointer).
    if (this.stopping.has(key)) {
      await this.stopping.get(key)
      return this.ensureClient(name, sessionKey)
    }
    this.assertNotCrashLooping(name, sessionKey, key)
    const starting = this.startClient(name, sessionKey, key)
    this.starting.set(key, starting)
    try {
      const entry = await starting
      this.startReaper()
      return entry
    } finally {
      this.starting.delete(key)
    }
  }

  private async startClient(
    name: string,
    sessionKey: string,
    key: string,
  ): Promise<ClientEntry> {
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
        mode: cfg.acp.mode,
        env: this.opts.env?.[name],
        cwd: this.resolveSpawnCwd(name),
        image: this.opts.image?.[name],
        mounts: this.resolveSpawnMounts(name),
      },
      // Per-conversation identity: container runtimes name the container after
      // it, so one conversation's spawn cannot reap another's container.
      instanceId: key,
      // One shared store per agent: independent stores on the same
      // sessions.json would each rewrite the whole file from their own map.
      sessionStore: this.storeFor(name),
      agentDataDir: this.opts.agentsDir ? join(this.opts.agentsDir, name) : undefined,
      runtime: this.runtimeFor(name),
      onEvent: (e) => this.onEvent(name, e),
      onApprovalRequest: (req) => this.onApprovalRequest(name, req),
      onElicitationRequest: this.onElicitationRequest
        ? (req, signal) => this.onElicitationRequest!(name, req, signal)
        : undefined,
      onTap: this.opts.onTap ? (e) => this.opts.onTap!(name, e) : undefined,
      onLifecycle: (e) => {
        this.opts.onLifecycle?.(name, e)
        // A closed session no longer owns its context spawn. An `unsupported`
        // idle close keeps the session alive, so it is left alone.
        //
        // `failed` is only the end of a session when the *close* failed, which
        // is the path that sets `reason` ('idle' | 'clear'). The client also
        // emits `{ outcome: 'failed', reason: undefined }` when a restore
        // (`resumeSession`/`loadSession`) throws: it then falls straight through
        // to `newSession` with the mcpServers it minted moments earlier, so
        // releasing that spawn here would leave the fresh session with a dead
        // context server for its whole life — every `zooid_*` call answering
        // `binding not owned by caller`, with no way to repair it.
        if (e.outcome === 'closed' || (e.outcome === 'failed' && e.reason !== undefined)) {
          this.releaseBinding(name, e.sessionKey)
        }
      },
      sessionIdleTimeoutMs: cfg.session_idle_timeout_ms,
      contextSpawn: this.opts.contextSpawns?.[name],
      timeouts: this.resolveTimeouts(name),
    })
    try {
      await client.start()
    } catch (err) {
      // Don't leak a half-started child when the handshake fails/times out.
      void client.stop().catch(() => {})
      this.recordCrash(key, 0, name, sessionKey)
      throw err
    }
    const entry: ClientEntry = {
      client,
      agent: name,
      sessionKey,
      startedAt: Date.now(),
      lastUsed: Date.now(),
    }
    this.clients.set(key, entry)
    return entry
  }

  /**
   * Take a conversation out of service: remove it from dispatch, close its ACP
   * session (the caller's `close`), kill its process, release its context
   * binding. The entry is deleted and `stopping[key]` published synchronously,
   * before any await, so a dispatch arriving mid-teardown waits for the
   * teardown rather than running on the process being killed.
   */
  private retireEntry(
    entry: ClientEntry,
    why: string,
    close: () => Promise<void>,
  ): Promise<void> {
    const key = this.clientKey(entry.agent, entry.sessionKey)
    if (this.clients.get(key) !== entry) return Promise.resolve()
    this.clients.delete(key)
    const stopping = (async () => {
      try {
        await close()
      } catch (err) {
        console.warn(
          `[acp:${entry.agent}] close before stop failed for ${entry.sessionKey} (${why}):`,
          err,
        )
      }
      await entry.client.stop().catch((err) => {
        console.warn(`[acp:${entry.agent}] stop of ${entry.sessionKey} failed (${why}):`, err)
      })
      // The process is gone, so nothing can answer through its context spawn
      // any more; release the binding. #48's releaseSession is idempotent, so
      // an already-closed session's release here is harmless.
      this.releaseBinding(entry.agent, entry.sessionKey)
      console.log(`[acp:${entry.agent}] stopped process for ${entry.sessionKey} (${why})`)
    })()
    this.stopping.set(key, stopping)
    void stopping.finally(() => {
      if (this.stopping.get(key) === stopping) this.stopping.delete(key)
    })
    return stopping
  }

  /**
   * Idle reap: close the ACP session (keeping the persisted pointer so the next
   * turn resumes it) and then kill the process.
   */
  private reapEntry(entry: ClientEntry, why: string): Promise<void> {
    return this.retireEntry(entry, why, () => entry.client.closeIdleSession(entry.sessionKey))
  }

  private startReaper(): void {
    if (this.reaper) return
    const timeouts = Object.keys(this.opts.agents)
      .map((name) => this.processIdleTimeoutFor(name))
      .filter((ms) => ms > 0)
    if (timeouts.length === 0) return
    const interval = Math.max(1_000, Math.min(30_000, Math.floor(Math.min(...timeouts) / 2)))
    this.reaper = setInterval(() => {
      void this.reapIdle()
    }, interval)
    this.reaper.unref?.()
  }

  /**
   * Crash-loop breaker, per conversation. A process that fails to start or
   * dies within {@link QUICK_DEATH_MS} is a crash; {@link CRASH_THRESHOLD} of
   * them inside {@link CRASH_WINDOW_MS} opens the circuit for a cooldown that
   * doubles up to {@link CRASH_COOLDOWN_MAX_MS}. Only this conversation is
   * refused — a crash-looping config or a broken image must not hold the rest
   * of the agent's threads hostage.
   */
  private recordCrash(key: string, lifetimeMs: number, name: string, sessionKey: string): void {
    if (lifetimeMs >= QUICK_DEATH_MS) {
      this.crashes.delete(key)
      return
    }
    const now = Date.now()
    const state = this.crashes.get(key) ?? { failures: [], openUntil: 0, cooldown: 0 }
    state.failures = state.failures.filter((t) => now - t < CRASH_WINDOW_MS)
    state.failures.push(now)
    if (state.failures.length >= CRASH_THRESHOLD) {
      state.cooldown =
        state.cooldown === 0 ? CRASH_COOLDOWN_MS : Math.min(CRASH_COOLDOWN_MAX_MS, state.cooldown * 2)
      state.openUntil = now + state.cooldown
      state.failures = []
      console.error(
        `[acp:${name}] ${sessionKey} crashed ${CRASH_THRESHOLD} times within ` +
          `${CRASH_WINDOW_MS / 1000}s; refusing to respawn it until ` +
          `${new Date(state.openUntil).toISOString()} (cooldown ${state.cooldown / 1000}s)`,
      )
    }
    this.crashes.set(key, state)
  }

  private assertNotCrashLooping(name: string, sessionKey: string, key: string): void {
    const state = this.crashes.get(key)
    if (!state || state.openUntil <= Date.now()) return
    throw new Error(
      `[acp:${name}] refusing to spawn a process for ${sessionKey}: it crash-looped ` +
        `(${CRASH_THRESHOLD} failed starts/exits within ${CRASH_WINDOW_MS / 1000}s). ` +
        `Cooling down until ${new Date(state.openUntil).toISOString()}; ` +
        `other conversations are unaffected.`,
    )
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
