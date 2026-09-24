import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import type { AcpRuntime, AcpSpawnSpec } from '@zooid/core'

export interface DockerAcpRuntimeOptions {
  /** Default image when the spec doesn't specify one. */
  defaultImage?: string
  /** docker (default) or podman. */
  engine?: 'docker' | 'podman'
  /**
   * Prefix for the deterministic per-agent container name. The final name is
   * `<prefix>-<sanitised agentId>` (default `zooid-agent`).
   */
  containerNamePrefix?: string
}

/**
 * DockerAcpRuntime spawns the ACP shim inside a container.
 *
 * argv shape:
 *   `<engine> run --rm -i [--name zooid-agent-<id> --label zooid.agent=<id>]
 *    [-w cwd] [-v ...] [-e ...] --entrypoint cmd image [args...]`
 *
 * The image comes from the spec (preferred) or the runtime's defaultImage.
 * If neither is set, spawn() throws.
 *
 * When the spec carries an `agentId`, each agent gets a deterministic
 * container name. A stale container with that name (e.g. one that outlived a
 * daemon restart, since `--rm` only reaps on child exit) is force-removed
 * before the new one starts, so duplicate agent containers cannot accumulate.
 */
export class DockerAcpRuntime implements AcpRuntime {
  private readonly engine: 'docker' | 'podman'
  private readonly namePrefix: string
  constructor(private readonly opts: DockerAcpRuntimeOptions = {}) {
    this.engine = opts.engine ?? 'docker'
    this.namePrefix = opts.containerNamePrefix ?? 'zooid-agent'
  }

  /** Deterministic, Docker-legal container name for an agent. */
  containerName(agentId: string): string {
    const safe = agentId
      .toLowerCase()
      .replace(/[^a-z0-9_.-]/g, '-')
      .replace(/^[^a-z0-9]+/, '')
    return `${this.namePrefix}-${safe || 'agent'}`
  }

  buildArgv(spec: AcpSpawnSpec): string[] {
    const image = spec.image ?? this.opts.defaultImage
    if (!image) {
      throw new Error(
        'DockerAcpRuntime: no image set (provide DockerAcpRuntimeOptions.defaultImage or AcpSpawnSpec.image)',
      )
    }
    const argv: string[] = ['run', '--rm', '-i']
    if (spec.agentId) {
      argv.push('--name', this.containerName(spec.agentId))
      argv.push('--label', `zooid.agent=${spec.agentId}`)
    }
    if (spec.cwd) {
      argv.push('-w', spec.cwd)
    }
    for (const m of spec.mounts ?? []) {
      argv.push('-v', `${m.path}:${m.target}:${m.mode}`)
    }
    const envEntries = Object.entries(spec.env ?? {}).sort(([a], [b]) => a.localeCompare(b))
    for (const [k, v] of envEntries) {
      argv.push('-e', `${k}=${v}`)
    }
    argv.push('--entrypoint', spec.command)
    argv.push(image)
    argv.push(...spec.args)
    return argv
  }

  spawn(spec: AcpSpawnSpec): ChildProcess {
    if (spec.agentId) this.reapStale(spec.agentId)
    return spawn(this.engine, this.buildArgv(spec), {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  }

  /**
   * Force-remove a pre-existing container for this agent before spawning.
   * Best effort: `docker rm -f` on a name that doesn't exist is a harmless
   * error, and a slow/absent engine must not block the spawn path.
   */
  private reapStale(agentId: string): void {
    try {
      spawnSync(this.engine, ['rm', '-f', this.containerName(agentId)], {
        stdio: 'ignore',
        // Bound the reap: a wedged docker CLI/daemon must not block the whole
        // daemon event loop on the cold-start path. On timeout `spawnSync` sets
        // `result.error` and returns, which the catch below ignores.
        timeout: 5_000,
      })
    } catch {
      // ignore — the spawn below will surface any real engine problem.
    }
  }
}
