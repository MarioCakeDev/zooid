# @zooid/runtime-vm

`runtime: vm` for zooid: each agent runs its ACP process in its own
[smolvm](https://smolmachines.com) microVM, booted from an OCI image.

```yaml
runtime: local
agents:
  smoke:
    runtime: vm
    acp: { command: node, args: [/workspace/agent.mjs] }
    vm:
      image: node:22-alpine
      cpus: 2
      memory: 2GiB
      disk: 8GiB
```

## Install smolvm

```bash
brew install smol-machines/tap/smolvm   # macOS (Apple Silicon)
```

## What the guest gets

- **Its workdir, read-only, at `/workspace`.** smolvm enforces `:ro`
  host-side, so not even root in the guest can write it. Files the daemon
  writes there (inbound attachments) show up in the guest.
- **No secrets in the workdir.** The daemon refuses to start if a vm agent's
  workdir holds `.env*`, `.dev.vars*` or `.claude/settings.local.json`: the
  guest can read everything in it.
- **No network unless you list hosts.** `vm.allow_hosts: [github.com, …]`
  turns on egress to exactly those hosts.
- **The env and mounts you give it, nothing else.** `vm.env` and `vm.mounts`
  work like `container.env` and `container.mounts`. Mounts are directories
  only (smolvm can't mount a single file), `rw` unless you say `mode: ro`.
  zooid passes no credential of its own: a model key goes in `vm.env`, and a
  login that refreshes itself goes in a `vm.mounts` directory.
- **No `zooid_*` context tools** in this release.

```yaml
    vm:
      image: ~/images/agent.tar
      allow_hosts: [github.com, chatgpt.com, auth.openai.com]
      env:
        PI_CODING_AGENT_DIR: /pi
      mounts:
        - { host: ~/.zooid/smoke-tester-pi, target: /pi }
```

**Anything you pass in, the guest can read**, and a `rw` mount is a place it
can write on the host. The VM protects the host from what the agent runs, not
the credentials you hand it. Pass a dedicated, revocable credential (a login
only this agent uses, or a key with a spending limit), and mount a directory
the host never executes or loads.

`vm.image` is a registry reference, or a local `docker save` archive or
rootfs directory when it starts with `/`, `./`, `../` or `~/`. Rebuilding a
local archive recreates the machine.

The machine is created and started when the daemon starts, stopped (not
deleted) when it stops, and recreated when its `vm:` settings change
(`vm.env` excepted: it goes to the agent's process, not the machine). See
ZOD109 and ZOD128.

## Tests

`pnpm test` runs the unit suites (and the smolvm integration files, which
skip without smolvm). `pnpm test:vm` runs them through the
ZOD098 tier guard, failing if it skipped. It is deliberately not named
`test:infra`: CI's infra job runs on Linux runners without smolvm, and
`runtime: vm` is macOS-only in this release.
