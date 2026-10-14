---
"zooid": minor
"@zooid/core": minor
"@zooid/runtime-vm": minor
---

A `runtime: vm` agent can reach the network, take env vars and mount host directories.

- `vm.allow_hosts` gives the guest a network limited to those hosts. Without it, the guest still has none.
- `vm.env` sets env vars on the agent's process in the guest, with the same rules as `container.env`.
- `vm.mounts` mounts host directories into the guest, with the same entries as `container.mounts` (`host`, `target`, `mode`, `create`). Directories only. A credential such as a harness login goes here or in `vm.env`. The guest can read anything you pass in, so use a dedicated, revocable one.
- `vm.image` accepts a local `docker save` archive or rootfs directory (`./…`, `../…`, `/…`, `~/…`). Rebuilding the archive recreates the machine.
- The zooid-tasks pi extension is not installed for vm agents, which have no context socket yet.
