# Native Pal foundation verification — 2026-10-02

The foundation was exercised with native Windows Node 22.20.0 and the device's
existing Windows Podman WSL machine. No new engine, model account or external
channel was installed or connected. These are local built consumer checks,
not a claim that the npm registry already contains this change.

## Actual paths exercised

- [CLI/SDK receipt](artifacts/pal-native-cli-sdk-20261002.json): native CLI creates
  a private Pal; production desktop Operator and ACP claim its conversation and
  start/view/close its real guest. An SDK query uses the same claimed log and
  real guest for write, read, glob, grep, bash and computer_use. Its file survives
  a computer restart. The caller retains its WSL UNC directory throughout.
- [Desktop receipt](artifacts/pal-desktop-native-windows-20261002.json): actual
  Electron renderer, preload IPC, Operator and native CLI create/switch/customize
  two Pals, persist state and start/view/refresh/stop the owned computer.
- [TUI receipt](artifacts/native-pal-tui-receipt.json): actual console input,
  exit and the exact printed PowerShell Resume command restore the same claimed
  conversation; the admitted computer produces a real PNG.
- [Provider lifecycle](artifacts/pal-local-computer-native-windows-20261002.json):
  guest isolation, browser interaction, profile persistence, background work,
  confirmed cancellation and owned cleanup.

Model inference in the CLI/SDK/TUI probes uses explicitly scripted/local
fixtures. The desktop probe does not prove every provider, permission dialog or
streaming event combination. External transports and a continuous Pal listener
are not exercised by this foundation.

## Reproducing the local consumer check

First build the authorized worktree. With WSL Node, run
`prepare-windows-consumer.mjs <repo> <new-destination>` using a **new**
`/mnt/c/Users/<operator>/AppData/Local/Temp/namzu-native-consumer-*` directory.
The script copies installed runtime dependencies and image assets; it does not
install packages, change npm shims or overwrite an existing snapshot. Run its
`link-native.mjs` with native Windows Node to create native dependency junctions.

Bundle [windows-pal-real-proof.mjs](windows-pal-real-proof.mjs) as Node ESM using
the already installed desktop Vite esbuild dependency. Include a createRequire
banner for bundled CommonJS dependencies. Pass the snapshot's native Windows
path as its argument. The proof refuses a non-Windows host and creates only a
new private Pal/home beneath that snapshot. See the separate
[console harness](native-tui-proof/README.md) for actual native TUI input.

Select the machine, connection and binary explicitly with the process-local
`NAMZU_PAL_PODMAN_MACHINE`, `NAMZU_PAL_PODMAN_CONNECTION` and
`NAMZU_PAL_PODMAN_BINARY` variables. The machine and image must already be ready;
the provider does not install or start them. When invoked from WSL, pass those
variables through `WSLENV` and retain the UNC parent cwd to cover this regression.
The [deployment record](PAL-LOCAL-COMPUTER-DEPLOYMENT-20261002.md) describes the
owned image context and actual isolation limits.

Screenshots and raw runtime state remain in private Windows temporary
directories. Commit only the sanitized receipts. Successful teardown leaves
the fixture volumes intentionally persistent and preserves unrelated containers
and the user's default connection.
