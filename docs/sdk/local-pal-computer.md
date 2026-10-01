---
type: Reference
title: Local Pal computers
description: A persistent Linux guest desktop for SDK Pals, provided by a local Docker engine or an explicitly selected Windows WSL Podman machine and shared by CLI and desktop clients.
resource: packages/sandbox/src/local-virtual-computer/index.ts
tags: [sdk, pals, sandbox, desktop, local]
status: stable
generated: { by: process:codex, at: 2026-10-02T00:00:00Z }
---

# Local Pal computers

`@namzu/sdk` declares `PalEnvironmentProvider` and owns Pal identity and
admission. `@namzu/sandbox` implements `createLocalVirtualComputerProvider`.
The CLI and desktop use the same host provider; no desktop application is
required to use the SDK contract.

## Install the guest explicitly

The host must already have a local container engine running Linux containers.
Docker is the default; Windows and macOS can use their local Docker Desktop
Linux engine. The optional Podman adapter supports an explicitly selected,
already registered Windows WSL machine. It does not support arbitrary remote
Podman connections, Linux-native Podman, or macOS Podman machines. The guest
is a separate Linux container desktop with its own X server, visible Chromium,
terminal window, workspace and browser profile. It shares the engine's kernel;
it is not a dedicated-kernel VM or a remote/cloud computer.

From a source checkout:

```sh
docker build -f packages/sandbox/local-computer/Dockerfile -t namzu-local-computer:1 packages/sandbox
```

The npm package also includes `local-computer/` and `worker/server.js`. Use the
installed `@namzu/sandbox` package directory as the build context and
`local-computer/Dockerfile` as the Dockerfile. Building downloads the base image
and operating-system packages and is an explicit operator action. The provider
never installs an engine, starts a machine, changes a default connection,
builds an image or pulls an image.

```ts
import { createLocalVirtualComputerProvider } from '@namzu/sandbox'

const environments = createLocalVirtualComputerProvider({
  image: 'namzu-local-computer:1',
  width: 1280,
  height: 800,
})
const availability = await environments.probe?.()
```

Options are `image`, `engine`, `dockerBinary`, `engineEndpoint`, `podmanBinary`,
`podmanMachine`, `podmanConnection`, `readyTimeoutMs`, `width`, `height` and an
optional host `runner`. `engine` is `docker` or `podman`; omitting it keeps Docker
behavior unchanged. Podman requires both machine and connection names and
refuses `engineEndpoint`. The runner is an embedding and
test transport with daemon authority; it must never come from model input.
`LocalComputerCommandRunner.run` receives optional `signal`, `env` and `cwd`;
custom runners must honor the supplied working directory when starting native
commands.
Defaults are the image above, `docker`, the current local context, a 60-second
startup deadline, and 1280 by 800 pixels. Dimensions must be integers between
320 and 3840. A probe verifies the engine and installed image, without creating
a computer. A successful allocation additionally verifies real display geometry,
PNG capture, a running browser and the execution worker's exact protocol.

## Ownership and lifecycle

`acquire({ pal, conversationId, signal })` returns a `PalEnvironmentLease` with
the admitted Pal ID, environment ID, generation, `Sandbox`, `ComputerUseHost`
and `release()`. Paused Pals are refused. One Pal receives a named engine data
volume derived from its opaque ID; a different Pal receives a different volume.
The host `pal.workspace` is control metadata and is never mounted into the guest.
No host root, desktop socket, browser profile, credentials directory or Docker
socket is mounted. Guests have ordinary bridge-network egress; this provider
does not claim an outbound host allowlist or deny access to the host LAN.

Each provider holds one active lane per Pal. A deterministic container name
also prevents two host processes from opening the same Pal computer together.
An existing allocation is refused, including one left behind by a crashed host;
there is no automatic takeover of an unknown owner. Startup failure reconciles
the attempt's unique allocation label so a competing process's container is
never deleted by name. If cleanup cannot be confirmed, that lane stays fenced
and the error calls for recovery. This provider retains its failed attempt
cleanup closure: the next acquire retries only that known allocation and its
owned forwarding helper before allocating again. Repeated cleanup failure
keeps the lane fenced. It never adopts or removes an unknown allocation.

`release()` and `sandbox.destroy()` end the same lease and remove its owned
container. Graceful stop allows Chromium to flush its profile while its X server
still exists, then removal confirms the allocation ended. If graceful stop
fails, forced owned-container removal is the recovery path; recent browser
writes may then be lost. They do not delete its volume. The next admitted allocation uses the
same workspace and browser profile. Destroyed lease handles refuse new calls.
Running processes and open windows stop when the allocation ends; files and
profile state remain. Profile deletion and explicit recovery of an abandoned
container require operator actions, rather than ordinary pause or chat close.

The generation distinguishes allocations admitted by this provider. It is not
a distributed or durable scheduler generation counter. SDK callers must retain
the actual lease, rather than reconnect by a guessed ID or generation.

## Capabilities and boundary

The `Sandbox` executes commands and reads, writes, lists and walks files in
the guest using the existing authenticated streamed worker and its cancellation
protocol. It also implements `spawnDetached`: a host Node pipe bridge forwards
guest output to the job registry while the actual command runs in the guest.
It omits real PTY, TCP tunnel, streamed-file and
mutable-network capabilities. Ranged file reads are refused. The separate
`ComputerUseHost` captures the guest screen and supplies mouse movement, click,
drag, scroll, text and key input. Clipboard, host windows and accessibility-tree
capabilities are not advertised. Chromium is usable through the real guest
desktop. No semantic `BrowserHost` is claimed by this initial provider.

Background commands survive individual queries while the Pal's computer lease
is retained. The job registry owns their IDs, output and cancellation. A signal
requests guest process-tree cancellation, with escalation handled by the guest
worker; it does not merely close the host pipe. If the guest cannot confirm that its owned
tree stopped, the provider retires the whole computer before closing the bridge.
Its detached process provides `terminate(signal?): Promise<void>` in addition
to the existing `kill(signal): void`. The promise resolves only after guest
termination or owned-computer removal is confirmed and the bridge closes. If
both cancellation and removal fail, it rejects and keeps the bridge alive. The
registry retains the job as `running` with `recoveryRequired: true` and a safe
`stopError`, counts it against its owner's capacity, and allows termination to
be retried. It does not publish a killed job or discard ownership based only on
the host pipe ending. The fenced computer refuses further operations.
Destroying the computer first removes the guest allocation, then kills and awaits
every host bridge. A host crash disconnects IPC and requests guest cancellation;
an unconfirmed stop still needs operator recovery of the saved allocation.

The guest worker's maximum background lifetime is 2,147,000,000 milliseconds
(about 24.8 days), below Node's timer limit. Foreground calls retain their explicit
timeouts. Background output still has the worker's capture cap; exceeding it is
reported, in addition to the registry's independent retained-output accounting.

Every Docker command is pinned to a verified local Unix socket or local Windows
named pipe. TCP and arbitrary SSH engines, including localhost TCP, are refused. The engine
must report Linux containers. Control ports are published only on `127.0.0.1`;
the per-allocation token travels through the engine CLI environment and remains
host-side in the client. It is never embedded in the image, argv, result, renderer
payload or persistent Pal definition. Desktop routes reject browser-origin
requests and require the token even for readiness. Actions use argv, not a shell.

The reference image runs as UID/GID 1001, with a read-only root filesystem,
dropped capabilities, no-new-privileges and private IPC. Its own home volume and
temporary directories are writable. Chromium's inner process sandbox is disabled
because this constrained container does not provide its namespace/suid setup.
The container is the boundary, suitable for contained local agent work rather
than hostile multi-tenant workloads. A private Pal profile isolates one Pal from
other Pals; it does not hide profile files or control-process environment from
arbitrary commands running as that same guest user. Credential vaulting and
operator-only private sign-in need an additional grant/control boundary.

If a state-changing desktop request loses confirmation, the host raises
`computer_use_outcome_unknown` with unsafe retry metadata. It does not replay
the input. Loss of an execution-cancellation acknowledgement retires the owned
computer and reports whether retirement was confirmed.

## Explicit Windows Podman machine

Start an existing machine explicitly; the provider never starts it:

```powershell
$podman = 'C:\Users\Arda\AppData\Local\Programs\Podman\podman.exe'
& $podman machine start --update-connection=false podman-machine-default
& $podman --connection podman-machine-default-root build --file packages/sandbox/local-computer/Dockerfile --tag namzu-local-computer:1 packages/sandbox
```

Use the operator's installed binary path and registered machine/connection
names; the paths above are examples. For an installed npm package, use its
`local-computer/Dockerfile` and package root as described above.

```ts
import { createLocalVirtualComputerProvider } from '@namzu/sandbox'

const environments = createLocalVirtualComputerProvider({
  engine: 'podman',
  podmanBinary: 'podman',
  podmanMachine: 'podman-machine-default',
  podmanConnection: 'podman-machine-default-root',
})
```

The adapter verifies the machine's WSL registration, running state, current
Windows operator ownership, local pipe, machine connection marker, identity
path, loopback SSH port, user and Linux socket. Operations capture that verified
URL and identity, so later edits to a named connection cannot redirect a lease.
No SSH private-key contents are read by Namzu or passed to the model.
All native Podman and WSL transport commands use the resolved, existing Windows
operator profile as their working directory. UNC or relative profile directories
are refused. This avoids Podman's native Windows failure when an SDK application
inherits a WSL UNC working directory, without changing the application's own
directory. Explicit relative `podmanBinary` paths are resolved against the caller's
original directory; bare command names still use PATH. Docker keeps its existing
working-directory behavior.

Native Windows OpenSSH supplies two owned loopback forwards to that same
verified local machine. Its host public key comes directly from the registered
WSL distribution and is pinned in a temporary `known_hosts` file. The forward
uses strict host-key checking, the machine identity, and no user SSH config or
proxy commands. It does not enable the machine's user-mode networking or
change Windows forwarding settings. Missing OpenSSH or host-key/forwarding
failure prevents admission. Loss of a forward fences and retires the lease;
cleanup failure keeps ownership available for recovery.

The Windows WSL Podman adapter uses `--cgroups=disabled` for its own container
because existing WSL machines can lack delegated controllers. It imposes no
per-container CPU, memory or PID quotas. It retains private process/network/IPC
namespaces, the read-only root, non-root guest user, dropped capabilities,
no-new-privileges and the engine's default seccomp policy. Docker's invocation
is unchanged. The image uses Chromium `--no-sandbox`; the browser's inner
process sandbox is absent. The container and local engine/WSL boundary are the
isolation boundary, not a dedicated-kernel VM per Pal.

The CLI composition accepts `NAMZU_PAL_COMPUTER_ENGINE`,
`NAMZU_PAL_PODMAN_MACHINE`, `NAMZU_PAL_PODMAN_CONNECTION` and
`NAMZU_PAL_PODMAN_BINARY`. SDK embedders set factory options directly.
