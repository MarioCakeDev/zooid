# @zooid/runtime-vm

## 0.18.0

### Minor Changes

- c113da8: A `runtime: vm` agent can reach the network, take env vars and mount host directories.

  - `vm.allow_hosts` gives the guest a network limited to those hosts. Without it, the guest still has none.
  - `vm.env` sets env vars on the agent's process in the guest, with the same rules as `container.env`.
  - `vm.mounts` mounts host directories into the guest, with the same entries as `container.mounts` (`host`, `target`, `mode`, `create`). Directories only. A credential such as a harness login goes here or in `vm.env`. The guest can read anything you pass in, so use a dedicated, revocable one.
  - `vm.image` accepts a local `docker save` archive or rootfs directory (`./…`, `../…`, `/…`, `~/…`). Rebuilding the archive recreates the machine.
  - The zooid-tasks pi extension is not installed for vm agents, which have no context socket yet.

- b290fb6: Per-agent `runtime:` — a workforce can mix `local`, `docker`/`podman` and the
  new `vm` runtime, which runs an agent's ACP process in its own smolvm
  microVM with its workdir mounted read-only. Context tools and guest
  networking are not available under `vm` yet.

### Patch Changes

- Updated dependencies [c113da8]
- Updated dependencies [b290fb6]
  - @zooid/core@0.18.0
