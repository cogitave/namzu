# Local Pal computer deployment and verification — 2026-10-02

## Outcome on this device

A real private Linux guest desktop now runs through the production `@namzu/sandbox` provider under native Windows Node and the machine's existing local Podman installation. The actual lifecycle proof passed all 13 steps: guest terminal/files, 1280×800 PNG screen capture, visible Chromium GUI input, browser storage, a background HTTP server surviving independent calls, confirmed background tree cancellation, a second Pal's isolated files, release, reacquire, preserved workspace and browser localStorage, and final release.

This is a Linux **container desktop**, sharing the local engine/WSL kernel. Each Pal gets its own persistent home volume and its own display/browser/process namespace. It is not a separate dedicated-kernel virtual machine per Pal. The explicit Windows Podman adapter has no per-container CPU, memory or PID quota and Chromium runs with `--no-sandbox`; its inner browser process sandbox is absent. The container plus local engine/WSL boundary provides isolation. No host root, control workspace, browser profile, input/display socket, credential directory or engine socket is mounted into the guest.

Receipts:

- [Native Windows lifecycle](artifacts/pal-local-computer-native-windows-20261002.json)
- [Post-proof ownership inventory](artifacts/pal-local-computer-post-proof-20261002.json)
- [Existing-machine inventory/start](artifacts/pal-podman-existing-machine-inventory-20261002.json)
- [Original image build](artifacts/pal-podman-image-build-20261002.json)
- [Actual WSL CLI missing-engine admission](artifacts/pal-cli-missing-engine-wsl-20261002.json)

Screenshots remain outside Git at `C:\Users\Arda\AppData\Local\Temp\namzu-pal-native-lifecycle-kjlyzayc\`: `initial.png`, `browser.png`, and `restart.png`. The operator harness and its adjacent detached worker are in the same private directory. The proof used generated fixture Pal IDs, never the user's Pal registry/profile.

## Read-only device inventory

| Item | Observed state |
| --- | --- |
| Windows | Windows 10 Pro 64 bit, 10.0.19045.7725 |
| Hardware | AMD Ryzen 9 7950X3D, about 63.1 GiB RAM |
| Virtualization | Firmware virtualization enabled, hypervisor present; WSL, Virtual Machine Platform and Hyper-V feature install state 1 |
| WSL | 3.0.1; kernel 6.18.40.1; WSLg 1.0.79 |
| Operator distro | `archlinux`, running, WSL 2 |
| Native Node | `C:\Program Files\nodejs\node.exe`, 22.20.0 |
| Docker | No native or Linux Docker CLI; no standard Docker Desktop installation found |
| Linux alternatives | No Linux Podman, QEMU or equivalent supported engine found |
| Native Podman | 6.0.2, `C:\Users\Arda\AppData\Local\Programs\Podman\podman.exe` |
| Existing local machine | `podman-machine-default`, registered WSL provider, rootful, initially stopped |
| Native OpenSSH | `C:\Windows\System32\OpenSSH\ssh.exe` exists and actual forwarding passed |
| Other candidate | `wslc.exe` help inspected only; no provider or runtime proof, so not an admitted backend |

Docker's current Windows requirements include WSL 2.1.5+, hardware virtualization and at least 8 GB memory. This device meets those measured prerequisites. Docker also requires a Windows release within Microsoft's servicing timeline. Windows 10 Home/Pro standard support ended in October 2025; this device's ESU enrollment/vendor eligibility was not independently proved. Therefore these facts establish technical prerequisites, not a supported Docker Desktop installation. [Docker Windows installation](https://docs.docker.com/desktop/setup/install/windows-install/), [Microsoft Windows release information](https://learn.microsoft.com/en-us/windows/release-health/release-information).

Native Windows Docker usage does not itself require a particular Linux distro; Docker's explicit WSL integration governs CLI availability inside a distro. Installing a native engine would not automatically prove the WSL CLI route. [Docker WSL backend](https://docs.docker.com/desktop/features/wsl/).

## Existing runtime ownership

The authorized operation was exactly:

```powershell
$podman = 'C:\Users\Arda\AppData\Local\Programs\Podman\podman.exe'
& $podman machine start --update-connection=false podman-machine-default
```

There was no machine initialization, engine installation, default-connection change, networking reconfiguration or deletion/adoption of unrelated containers. Podman itself detected an existing SSH port conflict and changed its machine port from 52055 to 61420 while starting. The provider reads the current inspected port; it never hardcodes either value. `--update-connection=false` preserves the existing default selection. [Podman machine start](https://docs.podman.io/en/latest/markdown/podman-machine-start.1.html).

Post-proof inventory confirms the only remaining container is the pre-existing stopped `namzu-control-plane`, with the same full ID and exited state. The default remains `podman-machine-default-root`. No owned forwarding helpers remained after release. The borrowed machine is left running; stopping it could affect unrelated future user work. Fixture volumes remain intentionally persistent, matching the provider's lifecycle contract.

## Recommended path on this machine

Use the already installed **native Windows Podman + existing WSL machine**. Run the native Windows Namzu CLI/desktop host or SDK consumer with the explicit configuration below. The Podman adapter intentionally refuses `process.platform !== 'win32'`; invoking a Windows binary from Linux is not an equivalent proof of local transport or Windows ownership. WSL Namzu currently has no admitted engine and fails admission without host fallback.

```powershell
$env:NAMZU_PAL_COMPUTER_ENGINE = 'podman'
$env:NAMZU_PAL_PODMAN_MACHINE = 'podman-machine-default'
$env:NAMZU_PAL_PODMAN_CONNECTION = 'podman-machine-default-root'
$env:NAMZU_PAL_PODMAN_BINARY = Join-Path $env:LOCALAPPDATA 'Programs\Podman\podman.exe'
```

Set these only in the intended native process environment. There is no reason to change the user's global default Podman connection or `DOCKER_HOST`. SDK embedders use the corresponding factory options directly:

```ts
import { createLocalVirtualComputerProvider } from '@namzu/sandbox'

const environments = createLocalVirtualComputerProvider({
  engine: 'podman',
  podmanBinary: 'C:\\Users\\Arda\\AppData\\Local\\Programs\\Podman\\podman.exe',
  podmanMachine: 'podman-machine-default',
  podmanConnection: 'podman-machine-default-root',
})
```

Docker remains the factory default; Linux/macOS Docker usage is unchanged. Linux-native or macOS Podman support and generic remote SSH connections are not claimed by this adapter.

## Image preparation and package asset paths

The provider never starts a machine, builds, pulls or installs an image. Operator preparation is explicit. The shipped npm `@namzu/sandbox` package includes these image build assets:

- `local-computer/Dockerfile`
- `local-computer/entrypoint.sh`
- `local-computer/desktop-worker.cjs`
- `worker/server.js`

Use the **sandbox package root** as the build context, not `dist/` or the CLI package root. For this workspace under WSL, stage only those four assets in an owned native Windows temporary directory before native Podman builds; building directly with an inherited WSL/UNC working directory produced a concrete access error here. The successful build ran from its native context directory.

```powershell
$repo = '\\wsl.localhost\archlinux\home\arda\workspaces\@cogitave\cogitave\namzu-wt-schedule-ownership'
$source = Join-Path $repo 'packages\sandbox'
$context = Join-Path $env:TEMP ('namzu-pal-image-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $context, (Join-Path $context 'local-computer'), (Join-Path $context 'worker') | Out-Null
foreach ($asset in @('Dockerfile', 'entrypoint.sh', 'desktop-worker.cjs')) {
  Copy-Item -LiteralPath (Join-Path $source ('local-computer\' + $asset)) -Destination (Join-Path $context 'local-computer')
}
Copy-Item -LiteralPath (Join-Path $source 'worker\server.js') -Destination (Join-Path $context 'worker')
Push-Location $context
try {
  & $podman --connection podman-machine-default-root build --pull=never --file '.\local-computer\Dockerfile' --tag namzu-local-computer:1 '.'
  if ($LASTEXITCODE -ne 0) { throw 'Owned image build failed' }
} finally {
  Pop-Location
}
```

`--pull=never` requires an already cached base, which existed here. A first-time base pull needs an explicit operator preparation action. The image build installs Debian packages inside the guest image; no host package installation is performed. Do not overwrite a pre-existing user image with this tag without establishing ownership. This session created the tag, then rebuilt only that owned image after finding the browser-profile shutdown defect.

For a globally installed native Windows CLI, determine the package root without guessing its prefix. Run module resolution from the CLI package directory so its shipped dependency is found:

```powershell
$cliRoot = Join-Path (& npm root -g) '@namzu\cli'
Push-Location $cliRoot
try {
  $sandboxRoot = & node --input-type=module -e "import{dirname}from'node:path';import{fileURLToPath}from'node:url';console.log(dirname(dirname(fileURLToPath(import.meta.resolve('@namzu/sandbox')))))"
  if ($LASTEXITCODE -ne 0) { throw 'Installed CLI does not expose the sandbox dependency' }
} finally { Pop-Location }
```

Build from `$sandboxRoot` with `local-computer/Dockerfile`, or copy the four assets into an owned native context as above. The installed package must contain this provider change; the current unmerged workspace is not a claim that npm already ships it. A native consumer should retain the complete `dist/local-virtual-computer/` directory: `detached-process.js` starts adjacent `detached-worker.js`. Bundling only the provider entry would lose that adjacent helper unless it is deliberately bundled/copied as a second asset.

Current verified image:

- Name: `localhost/namzu-local-computer:1`
- ID: `3a34d95148b3a650fe504567fd9765e075582a32bf24e073589b3efea1a626cf`
- Digest: `sha256:49a669eb9bc78a727aef9c9b35d3e1f8b15739a2e2d0ef68f8354948aa96ad69`
- Linux; UID/GID `1001:1001`; protocol label `org.namzu.local-computer.protocol=1`

Read-only validation:

```powershell
& $podman --connection podman-machine-default-root image inspect --format '{{.Id}} {{.Os}} {{.Config.User}} {{index .Config.Labels "org.namzu.local-computer.protocol"}}' namzu-local-computer:1
& $podman system connection list --format json
& $podman --connection podman-machine-default-root ps --all --no-trunc --format json
```

## Actual compatibility defects found and fixed

1. **Cgroups:** this existing machine reported global controllers but its nested non-systemd container cgroup lacked the `pids` controller. A default Podman run failed with OCI exit 126; even `--pids-limit=-1` failed. The explicit Windows adapter uses per-container `--cgroups=disabled`, with no resource-quota claim, leaving user machine settings untouched. The engine's namespace/capability/readonly/seccomp confinement remains. [Podman run cgroups](https://docs.podman.io/en/latest/markdown/podman-run.1.html#cgroups-how).
2. **Control transport:** mapped control ports were alive on the machine's Linux loopback but native Windows loopback refused connections. The provider owns two native OpenSSH loopback forwards pinned to the inspected local machine. The host Ed25519 public key is read directly through its registered WSL distribution and pinned in a temporary `known_hosts`; strict host-key checking and disabled user SSH config/proxy commands prevent arbitrary redirect. The private key is referenced by path, not exposed to models. [OpenSSH forwarding](https://man.openbsd.org/ssh.1), [OpenSSH configuration](https://man.openbsd.org/ssh_config.5).
3. **Persistent volumes:** Podman errors when `volume create` sees an existing name; the adapter adds `--ignore`, then verifies the volume's exact Pal owner label. It never relabels/adopts another Pal's volume.
4. **Native command directory:** a real SDK consumer launched from a WSL UNC directory failed before container creation with Podman exit 125, `open /proc/self/uid_map: The directory name is invalid.` The same proof passed when only its parent working directory changed to its own native Windows fixture directory. Podman 6.0.2's client ignores absent `/proc` mapping files but returns other filesystem errors, explaining the UNC-specific failure. Production now pins all Podman and WSL transport calls to a validated native Windows operator profile directory, without changing the embedding application's directory. Explicit relative binary paths retain the caller's original directory for resolution; bare command names use PATH. [Podman 6.0.2 ID mapping source](https://github.com/podman-container-tools/podman/blob/v6.0.2/pkg/util/utils.go).
4. **Browser persistence:** force removal lost the last localStorage writes in a real release/reacquire test. The provider now requests graceful stop before exact-ID removal. The guest shell stops/waits Chromium before Xvfb, allowing profile flush. Forced removal is still the recovery path if graceful stop fails; recent browser writes can then be lost.
5. **Forward lifecycle:** helper close is confirmed, not inferred from a kill request. Partial temporary-file cleanup tolerates `ENOENT` on retry. Startup cleanup failure retains its exact helper/allocation authority in the provider; a later acquire retries only that known attempt before allocating again. Unknown allocations are never adopted. Unexpected helper loss fences guest calls and retires the owned allocation.

All control routes remain authenticated, with per-allocation tokens supplied through the engine environment/private client memory. Tokens are absent from image layers, engine argv, persisted Pal definitions, renderer payloads and receipts. The forwards bind only `127.0.0.1`. This is an exception for a verified **local registered WSL machine transport**, not permission for arbitrary SSH/TCP engines.

## Verification sequence and limits

1. Record machine/default connection and unrelated container inventory; select the existing machine explicitly.
2. Check the prebuilt image metadata and provider `probe()`; a probe creates no computer.
3. Acquire a generated fixture Pal and confirm SDK admission waits for actual screen geometry, PNG capture, browser process and execution protocol 2.
4. Execute guest `id -u`, `uname -s` and `pwd`; expected `1001`, `Linux`, `/home/namzu/workspace`. Prove the host-only control file was not mounted.
5. Write/read a guest file; capture the actual screenshot outside Git.
6. Start a guest background HTTP server, wait for its real readiness output, then access it from a second independent guest command. Drive the visible browser with `ComputerUseHost` keyboard/text input and capture its page.
7. Set same-origin browser localStorage. Use the actual guest browser's CDP only as operator verification, without claiming semantic `BrowserHost` support.
8. Stop the server through `BackgroundJobRegistry.kill`; await confirmed remote tree termination and bridge close, then verify its guest port rejects connections.
9. Acquire another fixture Pal, prove the first Pal's file is absent, and release it.
10. Release the first Pal, reacquire, prove generation advances and both the file and browser localStorage persist.
11. Release all owned leases and confirm no fixture containers or forwarding helpers remain; preserve volumes and unrelated user resources/defaults.
12. Separately exercise the shared SDK PalRuntime/query and native CLI/desktop composition. Provider success does not by itself prove every frontend path; those integration receipts are tracked by the root task.

The actual built WSL CLI missing-engine/TUI admission receipt used a private `NAMZU_HOME`: fixture creation exited 0; `pal chat` exited 69 with an unavailable-engine diagnosis; the host workspace stayed unchanged and no guest/conversation success was fabricated. No live Docker engine was available, so **Docker live smoke is not claimed**. macOS/Linux Docker and other WSL configurations require their own runtime proof. No host desktop fallback is implemented.
