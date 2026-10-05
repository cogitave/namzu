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
terminal launcher, Files application, workspace and browser profile. The actual
Openbox desktop has a green/charcoal wallpaper and a tint2 dock containing only
installed Chromium, Terminal and Files launchers. Chromium starts on its bundled
Namzu New Tab page with a blank omnibox, clock, web search and installed app grid.
Its bundled SVG wordmark uses the exact desktop and CLI block-letter geometry,
without loading a host font or importing either application at runtime.
These controls launch real guest applications. It shares the engine's kernel;
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

The image installs Blender, FreeCAD, GIMP, Inkscape, LibreOffice Draw, Mousepad,
OpenSCAD, Kdenlive, Godot 3, Solitaire, QGIS, KiCad and ParaView, alongside
Terminal and Files. Its 15 home launchers and icons are generated from actual
installed executables and Debian desktop entries; missing entries fail the image
build. The image does not claim unavailable reference applications such as
3D Slicer. OpenGL applications use the guest's Mesa software rendering rather
than host GPU access. Kdenlive includes its Frei0r effects and uses SDL's dummy
audio driver, keeping preview playback alive without exposing host audio devices.

Normal home and new tabs use a bundled Manifest V3 New Tab page with only
`nativeMessaging` permission. Startup and a cold dock reopen activate the bundled
extension, then navigate only their own uniquely marked startup tab through
`chrome://newtab/` using guest-loopback CDP. This preserves Chromium's normal
New Tab address handling, including a blank omnibox after it loses focus.
The guest launcher disables Chromium's separate stock New Tab footer with
`--disable-features=NtpFooter`, removing its **Customize Chromium** button from
the bundled home. Startup, native new tabs and dock reopen use the same browser
configuration; normal website address bars and the application grid remain.
No browser policy or user profile file is rewritten. The desktop worker starts
after that page and its real application catalogue are ready. Existing user
tabs and literal website arguments are retained.
Its fixed extension ID is the sole allowed origin
of the guest native host. Bounded length-prefixed messages select a known app ID;
they cannot supply commands, arguments, paths or environment. The host launches
fixed argv under the guest user with detached application stdio, preserving the
native protocol. Application launches discard Chromium's disabled D-Bus sentinel
while preserving a real guest session bus. No new HTTP endpoint, host computer
access or SDK control port is introduced. A delivered GUI action can start an ordinary guest process; its
startup may complete after input authority changes, like other guest workloads.
The image does not enable the extension in private browsing. Real websites keep their normal address
bar. The profile path and remote debugging configuration remain unchanged.

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
and `release()`, plus the optional exclusive `operatorControl` port described below.
Paused Pals are refused at allocation; an already warm computer can be controlled
manually while the SDK keeps its Pal paused. One Pal receives a named engine data
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

The image also supplies the standard `file` utility for format inspection.
A format label is a structural check, not proof that the output meets its task.

### Bounded artifact reads

The Pal sandbox's `readFile(path, { offset, length, signal })` supports byte
ranges when its authenticated file worker acknowledges range protocol version
1. The client probes `POST /read-file` with `{ capabilitiesOnly: true }` before
its first bounded read. An older image is refused before file contents are
requested; rebuild the local Pal image from the same Namzu release. There is
no fallback to a whole-file read or the operator's filesystem.

The worker acknowledges `{ readFileRanges: { version: 1, maxBytes: 33554432 } }`
and accepts `{ path, encoding: "base64", range: { version: 1, offset, length } }`.
Offsets and lengths are non-negative safe integers. Omitted offset means zero;
omitted length means the remaining bytes, limited to 32 MiB. A range beyond EOF
returns fewer bytes or an empty buffer. A zero length is a valid empty read.
These requests admit regular files only and keep an opened descriptor for the
read, checking its identity and real path against the configured guest roots.

A success response includes the exact requested `range`, `sizeBytes`, encoding
and content. The Pal client validates that acknowledgment and the bounded
base64 bytes. Unbounded `readFile(path)` retains its previous wire shape and
behavior. Current control authority, cancellation and busy-operation guards
apply to both forms.

[`view_image`](pal-work.md#inspecting-saved-image-artifacts) uses a bounded read
of 16 MiB plus one byte to refuse oversized images without loading the whole
file. This presents saved artifact pixels to a capable model; it does not
replace a fresh GUI screenshot or certify output quality.

Foreground launchers and registered background jobs have different owners.
The shipped Pal image permits an application started by a **successfully completed
foreground launcher** to remain open for the computer's lifetime. The host's
foreground client requests `normalExitPolicy: "computer-lifetime"`; the worker
must acknowledge that policy in its authenticated execution reservation before
the host admits the command. Rebuild an older local image from the same Namzu
release if this acknowledgment is absent. Per-command environment variables do
not select the policy. The image pins
`NAMZU_SANDBOX_NORMAL_EXIT_POLICY=computer-lifetime` at worker startup; the generic
container worker and registered background-job clients retain strict execution
ownership.

`createLocalVirtualComputerProvider` defaults to
`normalExitPolicy: "computer-lifetime"`. SDK hosts that need the previous command
lifetime or an older strict image can explicitly set `normalExitPolicy: "strict"`.
That choice does not permit applications to survive a foreground command's group;
registered background jobs remain strict under either choice.

The handoff occurs only after the foreground command closes with exit code zero,
no signal and no admitted cancellation or timeout. The completed result describes
the launcher, not the application's later exit. Remaining applications belong to
the exclusive guest allocation, are not invented job-registry entries, and stay
open during operator takeover. Stopping the computer removes their process
namespace. A failed launcher with surviving descendants or an unconfirmed command
cancellation still retires the allocation; a failed command whose whole group
has exited returns its actual failure result. The worker never signals a stale
numeric process-group ID after its leader has exited. Cancellation observed before
handoff while descendants remain cannot be reported as successful completion.
A command whose whole group already exited retains its natural result, and
cancellation of an already completed launcher returns its original terminal
result without claiming that its application stopped. Applications
launched from a shell should redirect inherited standard input/output/error so
their pipes do not hold that foreground call open.

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

## Live desktop transport

Closing and reopening Chromium through the dock keeps the computer alive;
shutdown validates the current profile process before requesting termination
and flushes the browser while X is still available. The controlled guest uses
Chromium test startup mode to omit bad-flag infobars; its inner sandbox remains
disabled under the existing container confinement described below.

The updated guest image runs x11vnc on guest loopback only. VNC port 5900 is
never published. x11vnc enforces `-viewonly` and disables clipboard/primary
selection exchange in both directions. The existing authenticated desktop
worker relays binary RFB bytes over WebSocket `/stream`; it refuses browser
Origins, missing/wrong bearer credentials, text frames and arbitrary upstream
targets. It limits viewer count and request size, propagates backpressure
without dropping framebuffer bytes, and closes owned sockets on guest release.

Readiness advertises `stream: { protocol: 'rfb' }` only after a real local VNC
banner probe succeeds. The provider then adds the host-only `screenStream`
descriptor to its lease. Older installed images remain compatible with existing
capture/input APIs and advertise no live-stream capability. Rebuild the image
explicitly using the installation commands above, then restart the owning
computer to use the new transport; running containers retain their old image.
The persistent volume and browser profile survive this stop/start.

A native viewer can render this byte stream with noVNC. Human input still uses
`operatorControl.executeInput` and its exact current generation; the RFB stream
cannot bypass exclusive SDK ownership. Observation neither transfers control
nor resumes paused work.

## Exclusive operator control

This provider adds `operatorControl` to the environment lease. `mode` is `pal`,
`operator` or `transitioning`. `takeOver()` reserves the transition synchronously
and refuses while any tracked foreground command, file request, desktop request
or detached guest job is pending. It preserves Pal control on refusal. The
embedding host must first cancel its owned queries and confirm background-job
termination; a cancellation request alone is not a completed handoff.

After a confirmed takeover, `Sandbox` command, file and detached-process
operations and every state-changing `ComputerUseHost` action refuse new calls.
The trusted host retains lease destruction for stop and recovery. This includes shell
commands and file access, so invoking Chromium or `xdotool` through an admitted
agent shell does not bypass the input owner. Bounded screenshots and display
metadata remain available to the native observer. The separate
`executeInput(input)` port accepts only mouse movement, click, drag, scroll,
text and keys on the existing guest desktop. It never targets the operator's
host desktop or exposes the worker endpoint or token to the renderer.

`returnControl()` refuses pending input and changes only authority. It does
not restart queries, run queued messages or replay a failed action. The provider
requires a fresh screenshot before subsequent agent GUI input. The SDK also
requires that the newly admitted agent itself captures a fresh screenshot;
a native preview cannot satisfy that admission's requirement.

### Held operator keyboard

The authenticated desktop readiness response may advertise
`heldKeyboard: { version: 1 }`. Only that acknowledged version enables
`operatorControl.heldKeyboard: true`; older images retain complete key taps.
Rebuild the local image alongside the runtime to enable held movement keys.
The optional input actions are `key_down` and `key_up` with one `key` and a
host-created `keyboardId`, or `release_keys` with only that `keyboardId`.
The worker validates exact shapes and a supported X keysym allowlist before
invoking `xdotool` with argv. Command words are refused because xdotool also
supports command chaining.

Each allocated worker tracks at most 16 simultaneous keyboard lifetimes and
32 held keys per lifetime. Duplicate press/release events are harmless;
cleanup releases only the named lifetime and retains keys held by another
lifetime. The client records confirmed held input and `returnControl()` reserves
the transition while it confirms all of its scoped releases. Failed or unknown
release outcomes retain operator authority and the existing stop-for-recovery
fence. There is no global key reset, host desktop input or automatic replay.

The desktop sends press/release events for ASCII keys, navigation keys and
modifiers, relying on the guest's repeat behavior rather than queuing browser
repeats. Shifted punctuation remains on the complete text/shortcut port because
xdotool would otherwise generate implicit Shift press/release events outside
the held lifetime. It preserves non-ASCII and AltGraph text through the existing
text port; IME composition and Tab remain in the host focus flow. On blur, hidden
window, stream loss, inactive pane or view disposal, cleanup uses the exact
Pal/generation captured at keydown, including when focus has already retired
pending new input. The host and SDK still require current operator authority;
cleanup cannot target a new allocation or another focus lifetime. Abrupt loss
of the host or transport is not a confirmed release and requires the existing
owned-computer recovery path.

An unconfirmed desktop mutation or remote file write fences further effects
and control changes until the owned computer is stopped. An unknown outcome
is not proof of idle state. These are host-admitted control guarantees over
tracked work, not hostile guest process revocation: an arbitrary guest command
that deliberately escapes the tracked process group or accesses same-user
worker internals is outside this local container boundary. Operator sign-in
is not a private credential vault isolated from later Pal guest commands.

## Explicit Windows Podman machine

Start an existing machine explicitly; the provider never starts it:

```powershell
$podman = 'C:\Users\Arda\AppData\Local\Programs\Podman\podman.exe'
Set-Location -LiteralPath 'C:\path\to\namzu'
& $podman machine start --update-connection=false podman-machine-default
& $podman --connection podman-machine-default-root build --file packages/sandbox/local-computer/Dockerfile --tag namzu-local-computer:1 packages/sandbox
```

Use the operator's installed binary path and registered machine/connection
names; the paths above are examples. Run native Windows builds from a native
drive working directory: an inherited WSL UNC working directory can cause Podman
to resolve a build context into an unreadable `/mnt/c/...` path. For an installed npm package, use its
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
