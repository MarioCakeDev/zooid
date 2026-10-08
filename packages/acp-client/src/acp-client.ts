import type { ChildProcess } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import { resolve as pathResolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import {
  client as acpClientApp,
  methods,
  type ClientSideConnection,
  type ClientConnection,
  type ClientCapabilities,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type SessionModeState,
  type AgentCapabilities,
} from '@agentclientprotocol/sdk'
import { toElicitationRequest, toRpcError } from './elicitation.js'
import { AgentProcess } from './agent-process.js'
import { SessionMap } from './session-map.js'
import { JsonFileSessionStore } from './session-store.js'
import { resolvePreset } from './presets.js'
import { acpUpdateToAgentEvent, approvalDecisionToPermissionResponse } from './event-mapping.js'
import { TurnTracker, type TapEvent } from './turn-tracker.js'
import { AcpSessionWedgeError, classify } from './errors.js'
import type {
  AgentConfig,
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  ElicitationRequest,
  ElicitationResponse,
  PromptInput,
  PromptResult,
} from './types.js'

/**
 * Minimal interface for an external process spawner. Mirrors `AcpRuntime`
 * in `@zooid/core` but kept structural here to avoid a back-edge.
 */
export interface SpawnRuntime {
  spawn(spec: {
    command: string
    args: string[]
    env?: Record<string, string>
    cwd?: string
    /** Container image. Honoured by container runtimes; ignored by local spawners. */
    image?: string
    /** Bind mounts. Honoured by container runtimes; ignored by local spawners. */
    mounts?: Array<{ path: string; target: string; mode: 'ro' | 'rw' }>
    /** Agent id. Container runtimes use it for deterministic container names. */
    agentId?: string
  }): ChildProcess
}

/**
 * Per-step deadlines for the ACP handshake. A child whose container was
 * recreated (or whose shim wedged) must fail fast instead of blocking
 * `ensureSession` forever.
 */
export interface AcpClientTimeouts {
  /** `initialize` during `start()`. Default 120_000ms. 0 disables the timer. */
  initializeMs?: number
  /** `loadSession` / `newSession` in `ensureSession()`. Default 60_000ms. 0 disables. */
  sessionMs?: number
  /**
   * Deadline for the *first* agent output after a prompt is written to the
   * ACP stream: any `sessionUpdate` (message chunk, tool call, plan) or the
   * `session/prompt` response counts as "alive". When it elapses the session
   * is treated as wedged, invalidated and thrown as {@link
   * AcpSessionWedgeError}. Default 300_000ms. 0 disables the check (never
   * recommended — a wedge is otherwise completely silent).
   */
  firstResponseMs?: number
}

const DEFAULT_INITIALIZE_TIMEOUT_MS = 120_000
const DEFAULT_SESSION_TIMEOUT_MS = 60_000
/**
 * Generous on purpose, and deliberately biased long. This fires only when the
 * agent has produced *nothing* at all — a slow-but-alive agent answers
 * eventually and is never flagged, so the cost of a miss (killing a healthy
 * agent mid-thought) dwarfs the cost of a late detection. 5m, not 2m.
 * Open to per-agent override via `agents.<name>.first_response_timeout`.
 */
const DEFAULT_FIRST_RESPONSE_TIMEOUT_MS = 300_000

export interface AcpClientOptions {
  agent: AgentConfig
  /**
   * Per-agent state directory (typically `<dataRoot>/agents/<agentId>/`).
   * `sessions.json` is written here so threads survive daemon restarts.
   * When omitted, session continuity across restarts is disabled (a warning
   * is logged once on first ensureSession).
   */
  agentDataDir?: string
  onEvent: (event: AgentEvent) => void
  onApprovalRequest: (req: ApprovalRequest) => Promise<ApprovalDecision>
  onElicitationRequest?: (req: ElicitationRequest, signal: AbortSignal) => Promise<ElicitationResponse>
  sessionIdleTimeoutMs?: number
  onLifecycle?: (event: SessionLifecycleEvent) => void
  /**
   * If set, the runtime is used to spawn the ACP shim process instead of
   * the built-in `AgentProcess` host-spawn path. Lets the daemon launch
   * the shim inside a container (DockerAcpRuntime) without changing the
   * AcpClient surface.
   */
  runtime?: SpawnRuntime
  /**
   * Observability tap. Receives the unfiltered ACP protocol stream plus
   * synthetic turn-boundary events (turn_started / turn_completed). Optional;
   * when omitted the client behaves as before.
   */
  onTap?: (e: TapEvent) => void
  /**
   * Optional per-spawn factory. When set, the returned spec is included in
   * `session/new mcpServers` (and `session/load mcpServers`) so the shim
   * connects to the daemon-side zooid-context MCP server for the session
   * lifetime. Called once per `ensureSession(threadId)`.
   */
  contextSpawn?: (
    threadId: string,
    channelId?: string,
    sessionKey?: string,
  ) => Promise<{
    name: string
    command: string
    args: string[]
    env: Array<{ name: string; value: string }>
  }>
  /** Handshake deadlines. See {@link AcpClientTimeouts}. */
  timeouts?: AcpClientTimeouts
}

export interface SessionLifecycleEvent {
  agentId: string
  sessionKey: string
  sessionId: string
  reason?: 'idle' | 'clear'
  outcome: 'closed' | 'failed' | 'unsupported' | 'recovered'
  recoveryMethod?: 'cached' | 'resume' | 'load' | 'new'
}

interface KeyLifecycle {
  tail: Promise<unknown>
  timer?: ReturnType<typeof setTimeout>
  prompts: number
  activeTurns: Set<Promise<void>>
  humans: number
  resetting: boolean
  closing: boolean
}

export class AcpClient {
  private process: AgentProcess | null = null
  private runtimeChild: ChildProcess | null = null
  private connection: Pick<ClientSideConnection, 'initialize' | 'newSession' | 'loadSession' | 'resumeSession' | 'closeSession' | 'setSessionMode' | 'prompt' | 'cancel'> | null = null
  private rawConnection: ClientConnection | null = null
  private readonly sessions = new SessionMap()
  private store: JsonFileSessionStore | null = null
  private storeLoaded: Promise<void> | null = null
  private agentCapabilities: AgentCapabilities = {}
  private readonly lifecycle = new Map<string, KeyLifecycle>()
  private readonly replay = new Set<string>()
  private readonly permissionCancels = new Map<string, Set<() => void>>()
  private readonly elicitationCancels = new Map<string, Set<AbortController>>()
  private generation = 0
  private warnedNoClose = false
  private warnedNoStore = false
  private initialized = false
  private readonly turns: TurnTracker | null
  private dead = false
  private deathReason: Error | null = null
  private readonly deathWaiters = new Set<(err: Error) => void>()
  /**
   * Resolvers for "this session produced *some* output" — armed by an in-flight
   * prompt so the first `sessionUpdate` (or the `session/prompt` response) can
   * disarm the wedge deadline. Keyed by ACP session id.
   */
  private readonly activityWatches = new Map<string, Set<() => void>>()
  private readonly timeouts: Required<AcpClientTimeouts>

  constructor(private readonly options: AcpClientOptions) {
    this.turns = options.onTap
      ? new TurnTracker({ agentId: options.agent.id, onTap: options.onTap })
      : null
    this.timeouts = {
      initializeMs: options.timeouts?.initializeMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
      sessionMs: options.timeouts?.sessionMs ?? DEFAULT_SESSION_TIMEOUT_MS,
      firstResponseMs: options.timeouts?.firstResponseMs ?? DEFAULT_FIRST_RESPONSE_TIMEOUT_MS,
    }
  }

  /**
   * Whether the client is still usable. False once the child exits/errors or
   * `stop()` runs. The registry drops and replaces clients that report false.
   */
  isAlive(): boolean {
    return this.initialized && !this.dead && this.connection !== null
  }

  async start(): Promise<void> {
    this.generation++
    this.clearTimers()
    this.warnedNoClose = false
    const { command, args } = this.resolveSpawn()
    let stdout: Readable
    let stdin: Writable
    let stderr: Readable | null = null
    if (this.options.runtime) {
      const child = this.options.runtime.spawn({
        command,
        args,
        env: this.options.agent.env,
        cwd: this.options.agent.cwd,
        image: this.options.agent.image,
        mounts: this.options.agent.mounts,
        agentId: this.options.agent.id,
      })
      this.runtimeChild = child
      if (!child.stdout || !child.stdin) {
        throw new Error('AcpClient: runtime returned a child without piped stdio')
      }
      this.watchChild(child, 'child')
      stdout = child.stdout
      stdin = child.stdin
      stderr = child.stderr
    } else {
      this.process = new AgentProcess({
        command,
        args,
        env: this.options.agent.env,
        cwd: this.options.agent.cwd,
      })
      this.watchChild(this.process, 'child')
      this.process.start()
      stdout = this.process.stdout
      stdin = this.process.stdin
      stderr = this.process.stderr
    }

    if (stderr) forwardStderr(stderr, this.options.agent.id)

    const input = Readable.toWeb(stdout) as ReadableStream<Uint8Array>
    const output = Writable.toWeb(stdin) as WritableStream<Uint8Array>
    const stream = ndJsonStream(output, input)

    const callbacks = this.buildClient()
    const app = acpClientApp({ name: 'zooid' })
      .onNotification(methods.client.session.update, (ctx) => callbacks.sessionUpdate(ctx.params))
      .onRequest(methods.client.session.requestPermission, (ctx) => callbacks.requestPermission(ctx.params))
    if (this.options.onElicitationRequest) {
      app.onRequest(methods.client.elicitation.create, (ctx) => this.onElicitation(ctx.params, ctx.signal))
    }
    this.rawConnection = app.connect(stream)
    const agent = this.rawConnection.agent
    this.connection = {
      initialize: (p) => agent.request(methods.agent.initialize, p),
      newSession: (p) => agent.request(methods.agent.session.new, p),
      loadSession: (p) => agent.request(methods.agent.session.load, p),
      resumeSession: (p) => agent.request(methods.agent.session.resume, p),
      closeSession: (p) => agent.request(methods.agent.session.close, p),
      setSessionMode: (p) => agent.request(methods.agent.session.setMode, p),
      prompt: (p) => agent.request(methods.agent.session.prompt, p),
      cancel: (p) => agent.notify(methods.agent.session.cancel, p),
    }

    const init = await this.withDeadline(
      'initialize',
      this.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: this.clientCapabilities(),
        clientInfo: { name: 'zooid', title: 'Zooid', version: '0.0.1' },
      }),
      this.timeouts.initializeMs,
    )
    this.agentCapabilities = init.agentCapabilities ?? {}
    this.initialized = true
  }

  async stop(): Promise<void> {
    this.markDead(new Error(`AcpClient(${this.options.agent.id}): stopped`))
    this.rawConnection?.close()
    this.rawConnection = null
    for (const controllers of this.elicitationCancels.values()) for (const controller of controllers) controller.abort()
    this.elicitationCancels.clear()
    this.generation++
    this.clearTimers()
    for (const cancels of this.permissionCancels.values()) for (const cancel of cancels) cancel()
    this.permissionCancels.clear()
    this.replay.clear()
    this.sessions.clear()
    this.lifecycle.clear()
    this.process?.kill()
    this.runtimeChild?.kill('SIGTERM')
    this.process = null
    this.runtimeChild = null
    this.connection = null
    this.initialized = false
  }

  async ensureSession(
    threadId: string,
    channelId?: string,
    contextThreadId?: string,
  ): Promise<string> {
    if (this.dead) {
      throw this.deathReason ?? new Error(`AcpClient(${this.options.agent.id}): client is dead`)
    }
    return this.enqueue(threadId, () =>
      this.ensureSessionLocked(threadId, channelId, contextThreadId),
    )
  }

  private async ensureSessionLocked(
    threadId: string,
    channelId?: string,
    contextThreadId?: string,
  ): Promise<string> {
    if (!this.connection || !this.initialized) {
      throw new Error('AcpClient.start() must be called before ensureSession()')
    }
    const generation = this.generation
    await this.ensureStoreLoaded()
    if (generation !== this.generation) throw new Error('ACP connection changed during session setup')

    const key = { threadId, agentId: this.options.agent.id }
    const cached = this.sessions.get(key)
    if (cached) {
      this.emitLifecycle(threadId, cached.sessionId, 'recovered', undefined, 'cached')
      this.scheduleIdle(threadId)
      return cached.sessionId
    }

    const mcpServers = this.options.contextSpawn
      ? [await this.options.contextSpawn(contextThreadId ?? threadId, channelId, threadId)]
      : []
    if (generation !== this.generation) throw new Error('ACP connection changed during session setup')
    process.stderr.write(
      `[acp-client:${this.options.agent.id}] ensureSession(${threadId}) mcpServers=${
        mcpServers.length === 0
          ? '[]'
          : JSON.stringify(
              mcpServers.map((s) => ({
                name: s.name,
                command: s.command,
                args: s.args,
              })),
            )
      }\n`,
    )

    const persisted = this.store?.get(threadId)
    if (persisted) {
      const request = {
        sessionId: persisted,
        cwd: pathResolve(this.options.agent.cwd ?? process.cwd()),
        mcpServers,
      }
      for (const method of ['resume', 'load'] as const) {
        if (method === 'resume' && !this.agentCapabilities.sessionCapabilities?.resume) continue
        if (method === 'load' && !this.agentCapabilities.loadSession) continue
        this.replay.add(`${generation}:${persisted}`)
        try {
          const recovered = await this.withDeadline(
            `${method}Session(${persisted})`,
            method === 'resume'
              ? this.connection.resumeSession(request)
              : this.connection.loadSession(request),
            this.timeouts.sessionMs,
          )
          if (generation !== this.generation) {
            throw new Error('ACP connection changed during recovery')
          }
          await this.applyMode(persisted, recovered.modes)
          this.sessions.set(key, { sessionId: persisted, startedAt: Date.now() })
          this.emitLifecycle(threadId, persisted, 'recovered', undefined, method)
          this.scheduleIdle(threadId)
          return persisted
        } catch (err) {
          // A dead client (child gone / handshake timed out) must surface, not
          // silently fall through to a newSession on the same broken connection.
          if (this.dead) throw err
          if (generation !== this.generation) throw err
          console.warn(
            `[acp-client:${this.options.agent.id}] ${method}Session(${persisted}) failed for ${threadId}:`,
            err,
          )
          this.emitLifecycle(threadId, persisted, 'failed', undefined, method)
        } finally {
          this.replay.delete(`${generation}:${persisted}`)
        }
      }
    }

    const { sessionId, modes } = await this.withDeadline(
      'newSession',
      this.connection.newSession({
        cwd: pathResolve(this.options.agent.cwd ?? process.cwd()),
        mcpServers,
      }),
      this.timeouts.sessionMs,
    )
    if (generation !== this.generation) throw new Error('ACP connection changed during session setup')
    await this.applyMode(sessionId, modes)
    if (generation !== this.generation) throw new Error('ACP connection changed during session setup')
    this.sessions.set(key, { sessionId, startedAt: Date.now() })
    await this.store?.set(threadId, sessionId)
    this.emitLifecycle(threadId, sessionId, 'recovered', undefined, 'new')
    this.scheduleIdle(threadId)
    return sessionId
  }

  /**
   * Run a `session/prompt` under a first-response deadline.
   *
   * A resumed-but-dead session is the nastiest failure this layer sees: the
   * shim happily accepts the notification (so `[matrix] -> agent` and
   * `prompt ->` both look correct), the ACP stream carries the
   * `user_message_chunk`, and then *nothing* ever comes back — no chunk, no
   * tool call, no error, container at 0% CPU. From outside, a wedged session
   * and a slow one look identical.
   *
   * So bound the silence. Any `sessionUpdate` for this session (message chunk,
   * tool call, plan) or a permission request means the session is alive: the
   * timer is disarmed and a slow-but-alive agent is never flagged. When the
   * deadline elapses we treat the session as dead — invalidate it (in-memory
   * *and* the persisted store entry, so the next prompt gets a `session/new`
   * instead of resuming the same corpse) and mark the client dead, so the
   * registry reconnects with a fresh container rather than walking back into
   * the wedge. The resulting rejection is an {@link AcpSessionWedgeError},
   * which the registry uses to replay the prompt once.
   */
  private async withFirstResponse<T>(
    sessionId: string,
    threadId: string,
    work: Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    if (timeoutMs > 0) {
      const armed = this.armActivityWatch(sessionId)
      timer = setTimeout(() => {
        const err = new AcpSessionWedgeError(
          `AcpClient(${this.options.agent.id}): session ${sessionId} produced no output ` +
            `within ${timeoutMs}ms of a prompt; treating it as a wedged session`,
          { sessionId, timeoutMs },
        )
        // Forget the session *before* surfacing the failure, so no retry can
        // resume it, and drop the client so the next dispatch reconnects.
        // Done synchronously (not via the async `endSession`, which enqueues)
        // so the invalidation is observable before the rejection reaches the
        // caller: this fence is what stops a fresh client re-resuming the
        // corpse from the persisted store.
        armed.timer = undefined
        this.sessions.delete({ threadId, agentId: this.options.agent.id })
        void this.store?.delete(threadId)
        this.markDead(err)
      }, timeoutMs)
      armed.timer = timer
    }
    // timeoutMs 0 disables the timer. Note the wedge is surfaced *through the
    // death signal* rather than by rejecting this promise directly: that keeps
    // one failure channel for "this client is finished", which is what the
    // registry's reconnect logic already keys on. `withDeadline` still races
    // death unconditionally, so a child that exits mid-turn fails the prompt
    // promptly whether or not the first-response timer is enabled.
    try {
      return await this.withDeadline('prompt', work, 0)
    } finally {
      if (timer) clearTimeout(timer)
      this.clearActivityWatch(sessionId)
    }
  }

  /**
   * Register this session's first-response timer with the activity watcher so
   * the first inbound update can cancel it. Returns a handle that cancels the
   * timer without marking it as "alive".
   *
   * Invariant: **at most one in-flight prompt per session**, which is what lets
   * the first update clear the whole watcher set here. That holds because
   * `transport-matrix` serialises a thread's turns (`enqueueTurn`), but it is
   * not enforced here — anyone parallelising turns for one session must switch
   * this to a per-prompt handle rather than a per-session set.
   */
  private armActivityWatch(sessionId: string): { timer?: NodeJS.Timeout } {
    const entry: { timer?: NodeJS.Timeout } = {}
    const watches = this.activityWatches.get(sessionId) ?? new Set()
    const onActivity = () => {
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = undefined
      }
      this.clearActivityWatch(sessionId)
    }
    watches.add(onActivity)
    this.activityWatches.set(sessionId, watches)
    return entry
  }

  private clearActivityWatch(sessionId: string): void {
    this.activityWatches.get(sessionId)?.clear()
    this.activityWatches.delete(sessionId)
  }

  /**
   * Reject when the child dies, or after `timeoutMs` (0 = no timer). Racing
   * both the handshake and the death signal is what turns a wedged/dead
   * container into a real error instead of an indefinite `ensureSession` hang.
   */
  private async withDeadline<T>(label: string, work: Promise<T>, timeoutMs: number): Promise<T> {
    if (this.dead) {
      throw this.deathReason ?? new Error(`AcpClient(${this.options.agent.id}): client is dead`)
    }
    let timer: NodeJS.Timeout | undefined
    let onDeath: ((err: Error) => void) | undefined
    const death = new Promise<never>((_, reject) => {
      onDeath = reject
      this.deathWaiters.add(reject)
    })
    const guards: Promise<never>[] = [death]
    if (timeoutMs > 0) {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // A handshake that never completes means the connection is wedged,
          // not merely slow. Mark the client dead so `isAlive()` goes false and
          // the registry drops + reconnects instead of reusing it (and so a
          // `loadSession` timeout does not fall back to `newSession` on the
          // same unhealthy connection).
          const err = new Error(
            `AcpClient(${this.options.agent.id}): ${label} timed out after ${timeoutMs}ms`,
          )
          this.markDead(err)
          reject(err)
        }, timeoutMs)
      })
      guards.push(timeout)
      void timeout.catch(() => {})
    }
    void death.catch(() => {})
    void work.catch(() => {})
    try {
      return await Promise.race([work, ...guards])
    } finally {
      if (timer) clearTimeout(timer)
      if (onDeath) this.deathWaiters.delete(onDeath)
    }
  }

  private watchChild(child: EventEmitter, source: string): void {
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.markDead(
        new Error(
          `AcpClient(${this.options.agent.id}): ${source} exited (code=${code}, signal=${signal})`,
        ),
      )
    })
    child.on('error', (err: Error) => {
      this.markDead(new Error(`AcpClient(${this.options.agent.id}): ${source} error: ${err.message}`))
    })
  }

  private markDead(reason: Error): void {
    if (this.dead) return
    this.dead = true
    this.deathReason = reason
    for (const reject of this.deathWaiters) reject(reason)
    this.deathWaiters.clear()
  }

  private state(threadId: string): KeyLifecycle {
    let state = this.lifecycle.get(threadId)
    if (!state) {
      state = {
        tail: Promise.resolve(),
        prompts: 0,
        activeTurns: new Set(),
        humans: 0,
        resetting: false,
        closing: false,
      }
      this.lifecycle.set(threadId, state)
    }
    return state
  }

  private enqueue<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const state = this.state(threadId)
    const result = state.tail.then(work, work)
    state.tail = result.catch(() => {})
    return result
  }

  private clearTimer(threadId: string): void {
    const state = this.state(threadId)
    if (state.timer) clearTimeout(state.timer)
    state.timer = undefined
  }

  private clearTimers(): void {
    for (const threadId of this.lifecycle.keys()) this.clearTimer(threadId)
  }

  private scheduleIdle(threadId: string): void {
    const state = this.state(threadId)
    this.clearTimer(threadId)
    const timeout = this.options.sessionIdleTimeoutMs ?? 600_000
    if (
      !timeout ||
      state.prompts ||
      state.humans ||
      state.resetting ||
      state.closing ||
      !this.initialized
    ) return
    if (!this.sessions.get({ threadId, agentId: this.options.agent.id })) return
    const caps = this.agentCapabilities
    if (!caps.sessionCapabilities?.close) {
      this.warnNoIdleClose('session/close unsupported; adapter resources remain until process exit')
      return
    }
    // Closing is only safe when the session can come back: without resume or
    // load, the next message would silently start a fresh session.
    if (!caps.sessionCapabilities.resume && !caps.loadSession) {
      this.warnNoIdleClose('adapter cannot resume or load sessions; idle close disabled to keep context')
      return
    }
    const generation = this.generation
    state.timer = setTimeout(() => {
      if (generation === this.generation) void this.closeIdleSession(threadId)
    }, timeout)
    state.timer.unref?.()
  }

  private warnNoIdleClose(reason: string): void {
    if (this.warnedNoClose) return
    console.warn(`[acp-client:${this.options.agent.id}] ${reason}`)
    this.warnedNoClose = true
  }

  private emitLifecycle(
    sessionKey: string,
    sessionId: string,
    outcome: SessionLifecycleEvent['outcome'],
    reason?: SessionLifecycleEvent['reason'],
    recoveryMethod?: SessionLifecycleEvent['recoveryMethod'],
  ): void {
    this.options.onLifecycle?.({
      agentId: this.options.agent.id,
      sessionKey,
      sessionId,
      reason,
      outcome,
      recoveryMethod,
    })
  }

  setHumanRequestPending(threadId: string, pending: boolean): void {
    const state = this.state(threadId)
    state.humans = Math.max(0, state.humans + (pending ? 1 : -1))
    if (pending) this.clearTimer(threadId)
    else this.scheduleIdle(threadId)
  }

  async closeIdleSession(threadId: string): Promise<void> {
    const claim = this.state(threadId)
    if (claim.prompts || claim.humans || claim.resetting || claim.closing) return
    claim.closing = true
    return this.enqueue(threadId, async () => {
      const state = this.state(threadId)
      this.clearTimer(threadId)
      try {
        if (state.humans || state.resetting) return
        const key = { threadId, agentId: this.options.agent.id }
        const live = this.sessions.get(key)
        if (!live || !this.connection || !this.initialized) return
        if (!this.agentCapabilities.sessionCapabilities?.close) {
          this.warnNoIdleClose('session/close unsupported; adapter resources remain until process exit')
          this.emitLifecycle(threadId, live.sessionId, 'unsupported', 'idle')
          return
        }
        const generation = this.generation
        try {
          await this.connection.closeSession({ sessionId: live.sessionId })
          this.emitLifecycle(threadId, live.sessionId, 'closed', 'idle')
        } catch (err) {
          console.warn(
            `[acp-client:${this.options.agent.id}] idle close failed for ${threadId}/${live.sessionId}:`,
            err,
          )
          this.emitLifecycle(threadId, live.sessionId, 'failed', 'idle')
        } finally {
          if (generation === this.generation) this.sessions.delete(key)
        }
      } finally {
        state.closing = false
      }
    })
  }

  /**
   * Put a freshly created or loaded session into the agent's configured mode.
   * Mode ids are adapter-defined, so an id the adapter doesn't list is a
   * config error: fail the session rather than run it in a mode nobody chose.
   */
  private async applyMode(
    sessionId: string,
    modes: SessionModeState | null | undefined,
  ): Promise<void> {
    const wanted = this.options.agent.mode
    if (!wanted || !this.connection) return
    if (!modes) {
      throw new Error(
        `agents.${this.options.agent.id}.acp.mode "${wanted}": this agent does not offer session modes`,
      )
    }
    if (!modes.availableModes.some((m) => m.id === wanted)) {
      const offered = modes.availableModes.map((m) => m.id).join(', ')
      throw new Error(
        `agents.${this.options.agent.id}.acp.mode "${wanted}": not offered by this agent (offers: ${offered})`,
      )
    }
    if (modes.currentModeId === wanted) return
    await this.connection.setSessionMode({ sessionId, modeId: wanted })
  }

  private async ensureStoreLoaded(): Promise<void> {
    if (!this.store) {
      if (!this.options.agentDataDir) {
        if (!this.warnedNoStore) {
          console.warn(
            `[acp-client:${this.options.agent.id}] no agentDataDir configured; ` +
              `session continuity across restarts disabled`,
          )
          this.warnedNoStore = true
        }
        this.storeLoaded = Promise.resolve()
        return this.storeLoaded
      }
      this.store = new JsonFileSessionStore({
        agentId: this.options.agent.id,
        dir: this.options.agentDataDir,
      })
    }
    if (!this.storeLoaded) {
      this.storeLoaded = this.store.load().catch((err) => {
        console.warn(`[acp-client:${this.options.agent.id}] store load failed:`, err)
      })
    }
    await this.storeLoaded
  }

  private async flushStore(): Promise<void> {
    if (this.store) await this.store.flush()
  }

  async cancel(sessionId: string): Promise<void> {
    for (const controller of this.elicitationCancels.get(sessionId) ?? []) controller.abort()
    if (!this.connection || !this.initialized) return
    await this.connection.cancel({ sessionId })
  }

  /**
   * Cancel outstanding work, close the live ACP session when supported, and
   * forget the durable pointer so the next prompt starts fresh.
   */
  async endSession(threadId: string): Promise<void> {
    const state = this.state(threadId)
    state.resetting = true
    this.clearTimer(threadId)
    const key = { threadId, agentId: this.options.agent.id }
    const live = this.sessions.get(key)
    return this.enqueue(threadId, async () => {
      try {
        if (live) {
          for (const cancel of this.permissionCancels.get(live.sessionId) ?? []) cancel()
          for (const controller of this.elicitationCancels.get(live.sessionId) ?? []) controller.abort()
          if (state.activeTurns.size) {
            try {
              await this.cancel(live.sessionId)
            } catch (err) {
              console.warn(
                `[acp-client:${this.options.agent.id}] cancel failed for ${threadId}/${live.sessionId}:`,
                err,
              )
            }
            await Promise.allSettled([...state.activeTurns])
          }
        }
        await this.ensureStoreLoaded()
        const current = this.sessions.get(key)
        if (
          current &&
          this.connection &&
          this.initialized &&
          this.agentCapabilities.sessionCapabilities?.close
        ) {
          try {
            await this.connection.closeSession({ sessionId: current.sessionId })
            this.emitLifecycle(threadId, current.sessionId, 'closed', 'clear')
          } catch (err) {
            console.warn(
              `[acp-client:${this.options.agent.id}] clear close failed for ${threadId}/${current.sessionId}:`,
              err,
            )
            this.emitLifecycle(threadId, current.sessionId, 'failed', 'clear')
          }
        } else if (current) {
          this.warnNoIdleClose('session/close unsupported; adapter resources remain until process exit')
          this.emitLifecycle(threadId, current.sessionId, 'unsupported', 'clear')
        }
        this.sessions.delete(key)
        await this.store?.delete(threadId)
      } finally {
        state.humans = 0
        state.resetting = false
      }
    })
  }

  async prompt(input: PromptInput): Promise<PromptResult> {
    const generation = this.generation
    const state = this.state(input.threadId)
    state.prompts++
    this.clearTimer(input.threadId)
    let sessionId: string | null = null
    let turnId: string | null = null
    try {
      const launched = await this.enqueue(input.threadId, async () => {
        const id = await this.ensureSessionLocked(
          input.threadId,
          input.channelId,
          input.contextThreadId,
        )
        sessionId = id
        const promptText = stringifyPromptForLog(input.content)
        turnId = this.turns?.startTurn({ sessionId: id, promptText }) ?? null
        debugLog(this.options.agent.id, 'prompt →', {
          sessionId: id,
          content: input.content,
        })
        let finish!: () => void
        const completed = new Promise<void>((resolve) => { finish = resolve })
        const raw = this.connection!.prompt({ sessionId: id, prompt: input.content })
        const result = this.withFirstResponse(
          id,
          input.threadId,
          raw,
          this.timeouts.firstResponseMs,
        )
        state.activeTurns.add(completed)
        void result.finally(() => {
          state.activeTurns.delete(completed)
          finish()
        }).catch(() => {})
        return { id, result }
      })
      const result = await launched.result
      this.turns?.endTurn({ sessionId: launched.id, stopReason: result.stopReason })
      debugLog(this.options.agent.id, 'prompt ←', {
        sessionId: launched.id,
        stopReason: result.stopReason,
      })
      return { stopReason: result.stopReason, sessionId: sessionId ?? undefined }
    } catch (err) {
      const c = classify(err)
      this.options.onTap?.({
        kind: 'error',
        agentId: this.options.agent.id,
        sessionId,
        turnId,
        code: c.code,
        message: err instanceof Error ? err.message : String(err),
        detail: err instanceof Error && err.stack ? err.stack.slice(0, 2000) : undefined,
        transient: c.transient,
        acp_error: c.acp_error,
      })
      if (sessionId) this.turns?.endTurn({ sessionId, stopReason: 'error' })
      throw err
    } finally {
      state.prompts--
      if (generation === this.generation) this.scheduleIdle(input.threadId)
    }
  }

  /** An inbound update for `sessionId` arrived: the session answered. */
  private notifyActivity(sessionId: string): void {
    const watches = this.activityWatches.get(sessionId)
    if (!watches) return
    for (const onActivity of watches) onActivity()
  }

  private resolveSpawn(): { command: string; args: string[] } {
    const { preset, command, args, model } = this.options.agent
    if (command) {
      return { command, args: args ?? [] }
    }
    if (preset) {
      return resolvePreset(preset, { model })
    }
    throw new Error('AcpClient: agent must specify either `preset` or `command`')
  }

  private clientCapabilities(): ClientCapabilities {
    return {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      ...(this.options.onElicitationRequest ? { elicitation: { form: {} } } : {}),
    }
  }

  private async onElicitation(
    params: CreateElicitationRequest,
    signal: AbortSignal,
  ): Promise<CreateElicitationResponse> {
    const agentId = this.options.agent.id
    let request: ElicitationRequest
    try { request = toElicitationRequest(params) } catch (err) { throw toRpcError(err) }
    const threadId = [...this.lifecycle.keys()].find(
      (key) => this.sessions.get({ threadId: key, agentId })?.sessionId === request.sessionId,
    )
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const controllers = this.elicitationCancels.get(request.sessionId) ?? new Set<AbortController>()
    controllers.add(controller)
    this.elicitationCancels.set(request.sessionId, controllers)
    if (threadId) this.setHumanRequestPending(threadId, true)
    debugLog(agentId, 'createElicitation', { sessionId: request.sessionId, toolCallId: request.toolCallId })
    // An elicitation request is the agent asking a question: it is alive and
    // working, exactly like a permission request. Disarm the first-response
    // wedge deadline before awaiting the human, or an agent that opens with a
    // question would be declared wedged while it waits for the answer.
    this.notifyActivity(request.sessionId)
    try {
      const response = await this.options.onElicitationRequest!(request, controller.signal)
      if (signal.aborted) throw signal.reason
      // A local session cancellation also settles the pending operation.
      if (controller.signal.aborted) return { action: 'cancel' }
      debugLog(agentId, 'createElicitation ←', { action: response.action })
      return response
    } catch (err) {
      throw toRpcError(err)
    } finally {
      signal.removeEventListener('abort', abort)
      controllers.delete(controller)
      if (!controllers.size) this.elicitationCancels.delete(request.sessionId)
      if (threadId) this.setHumanRequestPending(threadId, false)
    }
  }

  private buildClient(): Client {
    const agentId = this.options.agent.id
    const generation = this.generation
    return {
      sessionUpdate: async (params) => {
        if (generation !== this.generation || this.replay.has(`${generation}:${params.sessionId}`)) {
          return
        }
        // Any inbound update proves the agent is alive and processing — except
        // the ones a shim emits as ambient session metadata rather than turn
        // output. `available_commands_update` can arrive right after a prompt
        // on a session that is already wedged; letting it disarm the deadline
        // would let a dead session sail through on metadata alone.
        const update = params.update as { sessionUpdate?: string }
        if (update.sessionUpdate !== 'available_commands_update') {
          this.notifyActivity(params.sessionId)
        }
        this.turns?.observeUpdate(params.sessionId, params.update)
        debugLog(agentId, 'sessionUpdate', params)
        const event = acpUpdateToAgentEvent(params)
        if (event) this.options.onEvent(event)
        else debugLog(agentId, 'sessionUpdate dropped (unmapped)', params)
      },
      requestPermission: async (params) => {
        if (generation !== this.generation) return { outcome: { outcome: 'cancelled' } }
        debugLog(agentId, 'requestPermission', params)
        this.notifyActivity(params.sessionId)
        const tc = params.toolCall as {
          toolCallId: string
          kind?: string
          title?: string
          rawInput?: unknown
        }
        const threadId = [...this.lifecycle.keys()].find(
          (key) => this.sessions.get({ threadId: key, agentId })?.sessionId === params.sessionId,
        )
        if (threadId) this.setHumanRequestPending(threadId, true)
        let cancel!: () => void
        const cancelled = new Promise<ApprovalDecision>((resolve) => {
          cancel = () => resolve({ decision: 'cancel' })
        })
        const pending = this.permissionCancels.get(params.sessionId) ?? new Set<() => void>()
        pending.add(cancel)
        this.permissionCancels.set(params.sessionId, pending)
        try {
          const decision = await Promise.race([
            this.options.onApprovalRequest({
              sessionId: params.sessionId,
              toolCallId: tc.toolCallId,
              toolKind: tc.kind,
              toolTitle: tc.title,
              toolInput: tc.rawInput,
              options: params.options.map((o) => ({
                optionId: o.optionId,
                name: o.name,
                kind: o.kind,
              })),
            }),
            cancelled,
          ])
          debugLog(agentId, 'requestPermission ←', decision)
          return approvalDecisionToPermissionResponse(decision)
        } finally {
          pending.delete(cancel)
          if (!pending.size) this.permissionCancels.delete(params.sessionId)
          if (threadId) this.setHumanRequestPending(threadId, false)
        }
      },
    }
  }
}

function stringifyPromptForLog(content: PromptInput['content']): string {
  try {
    return JSON.stringify(content).slice(0, 4096)
  } catch {
    return '<unstringifiable>'
  }
}

function debugLog(agentId: string, label: string, payload?: unknown): void {
  if (payload === undefined) {
    process.stderr.write(`[${agentId}] ${label}\n`)
    return
  }
  let s: string
  try {
    s = JSON.stringify(payload)
  } catch {
    s = String(payload)
  }
  if (s.length > 2000) s = s.slice(0, 2000) + '…'
  process.stderr.write(`[${agentId}] ${label} ${s}\n`)
}

function forwardStderr(stream: Readable, agentId: string): void {
  let buf = ''
  const prefix = `[${agentId}] `
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      process.stderr.write(prefix + line + '\n')
    }
  })
  stream.on('end', () => {
    if (buf.length > 0) process.stderr.write(prefix + buf + '\n')
  })
}
