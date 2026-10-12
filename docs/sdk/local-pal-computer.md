---
type: Reference
title: Local Pal computers
description: A persistent Linux guest desktop for SDK Pals, provided by a local Docker engine, an explicitly selected Windows WSL Podman machine, or Windows' own wslc container CLI, and shared by CLI and desktop clients.
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

That builds the last stage, the full image. The Dockerfile has two stages, described
under [Image stages](#image-stages-and-the-bundled-light-image).

The npm package also includes `local-computer/` and `worker/server.js`. Use the
installed `@namzu/sandbox` package directory as the build context and
`local-computer/Dockerfile` as the Dockerfile. Building downloads the base image
and operating-system packages and is an explicit operator action. The provider
never installs an engine, starts a machine, changes a default connection,
builds an image or pulls an image.

The creative stage installs Blender 5.2.2 LTS, FreeCAD, GIMP, Inkscape, LibreOffice Draw, Mousepad,
OpenSCAD, Kdenlive, Godot 4.7.2, Solitaire, QGIS, KiCad and ParaView, alongside
Terminal and Files. Its 15 home launchers and icons are generated from actual
installed executables and Debian desktop entries; missing entries fail the image
build. The image does not claim unavailable reference applications such as
3D Slicer. OpenGL applications use the guest's Mesa software rendering rather
than host GPU access. Kdenlive includes its Frei0r effects and uses SDL's dummy
audio driver, keeping preview playback alive without exposing host audio devices.

Blender and Godot use official Linux x86-64 portable releases with fixed SHA-256
checksums verified during the image build. `/usr/local/bin/blender`, `godot` and
`godot4`, and the fixed home launchers, select those supported releases. Godot uses
the OpenGL compatibility renderer; these versions do not imply host GPU access.
The distribution's `/usr/bin/blender` and `/usr/bin/godot3` remain available for
explicit legacy work. Godot 3 projects require conversion before using the new
default launcher; preserve the original project and verify conversion in Godot 4.
Blender MCP automatic addon update checks and telemetry are disabled in the guest
environment, including home launches. Installing an addon or server remains an
explicit operator action; an updated binary alone does not install an MCP bridge.
An already running computer keeps its previous image until it is stopped and
opened again. Updating the image tag does not replace a live allocation.

Normal home and new tabs use a bundled Manifest V3 New Tab page with only
`nativeMessaging` permission. Startup and a cold dock reopen activate the bundled
extension, then navigate only their own uniquely marked startup tab through
`chrome://newtab/` using guest-loopback CDP. This preserves Chromium's normal
New Tab address handling, including a blank omnibox after it loses focus.
The guest launcher disables Chromium's separate stock New Tab footer with
`--disable-features=NtpFooter`, removing its **Customize Chromium** button from
the bundled home. Startup, native new tabs and dock reopen use the same browser
configuration; normal website address bars and the application grid remain.
The image carries one managed browser policy (`/etc/chromium/policies/managed/namzu.json`: browser sign-in, sync and promotions off), so the toolbar never offers "Sign in to Chromium?"; no user profile file is rewritten. The desktop worker starts
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

Options are `image`, `engine`, `dockerBinary`, `engineEndpoint`, `podmanBinary`, `wslcBinary`,
`podmanMachine`, `podmanConnection`, `readyTimeoutMs`, `width`, `height` and an
optional host `runner`. `engine` is `docker`, `podman` or `wslc`; omitting it keeps Docker
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

## Image stages and the bundled light image

`local-computer/Dockerfile` is two stages. Each stage lists on the Pal's home page, and checks when
it is built, only the applications it installed: `app-catalog.cjs` tags every application with
its stage, `prepare-home.cjs --stage <name>` generates `apps.json` and the icons for that stage's
applications, and records the stage in `/opt/namzu-computer/stage`, which the browser launcher and
the native host read at run time. There is no hand-kept list per stage.

| Stage | Tag | Contents | Size on disk |
|---|---|---|---|
| `base` | `namzu-local-computer:2` | Debian bookworm-slim, Xvfb, Openbox, tint2 dock, Chromium with the bundled New Tab page, Terminal, Files (pcmanfm), Text Editor (Mousepad), Node and the guest worker, Mesa software rendering | 1.18 GB |
| `creative` | `namzu-local-computer:2-creative` | `FROM base`, plus Blender, FreeCAD, GIMP, Inkscape, LibreOffice Draw, OpenSCAD, Kdenlive, Godot, Solitaire, QGIS, KiCad, ParaView and their launchers | about 7 GB |

Building without `--target` builds the last stage (`creative`), the same image as before the split.
`LOCAL_COMPUTER_IMAGE` stays `namzu-local-computer:1`; the light image is reached by passing
`image: 'namzu-local-computer:2'`. Every stage keeps the image label `org.namzu.local-computer.protocol`
and `USER 1001:1001` that the provider checks, and strips setuid and setgid bits (nothing in the guest
needs them; the container engine on Windows does not offer `no-new-privileges`).

`local-computer/build-image.mjs` builds one stage with a chosen engine binary, saves it, compresses
it and writes a manifest:

```sh
node packages/sandbox/local-computer/build-image.mjs --engine docker --stage base --out ./image
node packages/sandbox/local-computer/build-image.mjs --engine "C:\Program Files\WSL\wslc.exe" \
  --stage base --tag namzu-local-computer:2 --out .\image --format zst
```

`--engine` is any binary that has `build`, `image inspect` and `save` (`docker`, `podman`, `wslc`).
The output is `<tag>.tar.zst` (or `.tar.xz`, `.tar.gz`, `.tar`) and `manifest.json`:
`{ revision, stage, imageRef, imageId, protocol, file, sha256, tarSha256, sizeBytes, compressedBytes, format }`,
where `file` is the archive's name beside the manifest (the installer stager requires it), `sha256` the
archive's digest, `tarSha256` the uncompressed tar's and `sizeBytes` its size. Windows'
`wslc load -i` reads the compressed archive directly (it sniffs the content, so the extension does not
matter), so no decompression step sits between the installer's file and the engine. The manifest's
`imageId` and `sha256` identify the archive that shipped; the build is not byte-reproducible (apt and
layer timestamps differ per build, the size matches to the byte but the digests do not), so they are not
a reproducible-build claim.

### Measured (base stage, wslc 3.0.1 on Windows 10 build 19045)

| Step | Result |
|---|---|
| Cold `wslc build` (`--no-cache`, apt over the network) | 92 s; 103 s with `save` |
| Image on disk | 1.18 GB (1,200,803,328 bytes as a tar) |
| Archive formats | zstd -19 323.3 MB (default), zstd -19 `--long=27` 316.0 MB, zstd `--ultra -22 --long=27` 311.6 MB (230 s; passes `zstd -t`, Node's zlib and `wslc load -i` in 6.6 s, but needs a 128 MB decoder window for 11.6 MB less, so it is not used), xz -9e 294.7 MB, gzip -9 435.4 MB, zstd -3 410.0 MB |
| Compress | zstd -19 through Node's `zlib` about 5 minutes on one thread (Node's zstd stream fails with worker threads on), xz -9e about 3 minutes with threads |
| `wslc load -i` | accepts `.tar`, `.tar.gz`, `.tar.xz`, `.tar.zst` and `.tar.bz2` directly and detects the format from the content (a `.zst` file named without an extension loads too); a truncated archive fails with `unexpected EOF` and exit 1, junk with `invalid tar header` |
| Load time | 2.4 to 2.8 s for the zstd archive, 12.6 s for xz; warm-store figures (layers shared with another image already present), so a first load on an empty store takes longer and is not yet measured |
| Start | the guest answers `/healthz` in under a second and the desktop worker is ready 1.8 s later on a warm VM |

zstd is the default because Node and Electron decompress it natively and it loads five times faster
than xz; xz is 9 percent smaller if the installer size matters more (`--format xz`, needs the `xz`
program on the build machine). A caller loads `file` from `manifest.json` with
`wslc load -i <path>`, then checks `wslc image inspect` against `imageId` and `protocol`.

### In the Windows installer

`packages/desktop/scripts/stage-installer.mjs --pal-computer-image <archive>` (the manifest defaults
to `manifest.json` beside it) copies both into `resources/pal-computer/` of the installed app. The
archive is stored as built. With the base image the installer grows from 180 MB to 503 MB. An
update that changes only the version downloads about 1.4 MB: electron-updater's differential download
compares the installer's content-defined blocks, the default `nsis.differentialPackage` compresses
each file on its own (non-solid), and an unchanged image compresses to identical bytes, so its blocks
are all reused. Measured on two real image-carrying installers built from the same stage, 0.1.0 and
0.1.1 (the version is the only app change, `--config.extraMetadata.version=0.1.1`): 68 of 24,128
blocks differ, 1.36 MB (0.27 percent of 502.6 MB; electron-updater merges neighbouring ranges, so
expect a little more). The blockmaps are 525,711 and 525,797 bytes and the installers 502,554,887
and 502,554,874 bytes. An update with a real app change (a new `app.asar` or CLI) touches more
blocks and has not been measured yet, and whether the image's blocks stay reused when a large file
before it changes is unproven until it is. A new image revision downloads the whole archive once
(323 MB). Every figure needs the previous version's blockmap in the update feed. `stage-installer.mjs` refuses a
manifest whose `imageRef` is not `namzu-local-computer:<revision>`. The release workflow does not pass
`--pal-computer-image` yet, so CI-built installers carry only a `README.txt` in `pal-computer/` until
the image is wired into the pipeline. Nothing loads the image at run time yet.


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

The CLI composition accepts `NAMZU_PAL_COMPUTER_ENGINE` (`docker`, `podman` or
`wslc`), `NAMZU_PAL_PODMAN_MACHINE`, `NAMZU_PAL_PODMAN_CONNECTION`,
`NAMZU_PAL_PODMAN_BINARY` and `NAMZU_PAL_WSLC_BINARY`. SDK embedders set factory
options directly.

## Windows: wslc engine

`wslc` is Microsoft's container CLI for WSL (WSL 2.9.3 or newer; 3.0.1 is the
version this adapter was verified on). Each Windows user gets one private
session with its own lightweight virtual machine. It is not a distribution in
`wsl -l -v`, it does not share a machine with the person's other WSL
distributions, and the container sees no Windows drive: only the Pal's named
volume is mounted. The adapter needs no administrator rights to run. It is
the engine Namzu intends to set up for people on Windows, using a Linux image
that ships inside the Namzu installer; that setup is a separate, consented
operation owned by the application. The provider itself still never installs
an engine, starts a machine, builds an image or pulls an image.

```ts
import { createLocalVirtualComputerProvider } from '@namzu/sandbox'

const environments = createLocalVirtualComputerProvider({
  engine: 'wslc',
  // Optional. Defaults to %ProgramW6432%\WSL\wslc.exe (%ProgramFiles% when that is unset), then wslc on PATH.
  wslcBinary: 'C:\\Program Files\\WSL\\wslc.exe',
})
```

The engine is chosen only when asked for: `engine: 'wslc'`, or
`NAMZU_PAL_COMPUTER_ENGINE=wslc` with the optional `NAMZU_PAL_WSLC_BINARY` for
the CLI and desktop. It is never selected automatically. Run the host process
as a native Windows process, not from inside a WSL distribution. The worker
token reaches the container by inheriting the host process environment by name
(`--env NAMZU_SANDBOX_TOKEN`), never on a command line.

The engine probe runs `wslc version` (it must print `wslc <major>.<minor>.<patch>`
at or above 2.9.3), then `wslc ps -a -q`, the cheapest command that starts the
session. A missing image is detected with `image inspect`, which on wslc means
the Pal computer has not been set up yet.

### Typed setup errors

Failures that a person can act on are `LocalComputerSetupError` instances with
a stable `code`, so an application can choose its own words and actions without
parsing prose:

| `code` | Meaning | Source |
|---|---|---|
| `engine-missing` | `wslc` is not installed or did not print a version | spawn failure, unreadable `wslc version` |
| `engine-too-old` | the runtime is older than 2.9.3 | `wslc version` |
| `virtualization-off` | virtualization is off in firmware, or the hypervisor is not available | `0x80370102` |
| `blocked-by-policy` | the organisation disabled WSL containers | `0x8004060C` |
| `sdk-mismatch` | the installed runtime does not fit this Namzu | `0x8004060B` |
| `image-missing` | the Pal computer image is not loaded | `WSLC_E_IMAGE_NOT_FOUND` |

The three HRESULT rows are mapped from the engine's documented codes and have
not yet been observed on a real policy-blocked or virtualization-off PC; they
are pinned only by tests with synthetic stderr. A missing image has been
observed: `image inspect` exits non-zero with no code, and the provider reads
that (or `WSLC_E_IMAGE_NOT_FOUND`) as `image-missing`. Any other failure of
that command, such as a timeout or an engine crash, is reported as itself.

`probe()` returns the same code beside its `reason` as `setupCode` (for the
wslc engine's catch-all "required" answer it is `image-missing`), so an
application picks its words by the code and not by the message. The
`engine-missing` message reads "Linux container support is not installed on
this PC." and names no tool.

The codes come from the engine's stderr. The command runner keeps only
recognised machine-readable tokens (HRESULTs, `WSLC_E_*` and `HCS_E_*` names,
spawn error names) on the thrown `LocalCommandError`; no stderr text, path or
environment reaches a message. Messages are plain sentences with no codes.

### How the command line differs

The lifecycle is the same as for Docker and Podman. Each place the dialects
differ lives in one module (`dialect.ts`) and the argument lists of Docker and
Podman are pinned byte for byte by a golden test.

| Step | Docker and Podman | wslc |
|---|---|---|
| Hardening flags | `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--read-only`, `--ipc=private` | none, wslc has no such options |
| Resource flag | Podman adds `--cgroups=disabled` | none |
| Find containers | `ps --all --filter F --format '{{.ID}}'` | `ps -a --filter F -q --no-trunc` (`-q` alone cuts ids to 12 characters; `--format` takes only `json`) |
| Published ports | `inspect --format '{{json .NetworkSettings.Ports}}'` | `inspect -f json`, read `[0].Ports`, falling back to `[0].NetworkSettings.Ports` |
| Volume | `volume create` (Podman adds `--ignore`) | `volume inspect`, then `volume create` only if absent |
| Engine endpoint | context or `--host` | none; the binary is called directly, no forwarding is needed because wslc publishes loopback ports on Windows |

### Hardening differences, stated plainly

On Docker the guest container drops every capability, forbids privilege
gain, mounts the root file system read-only and uses a private IPC namespace.
**On wslc none of those four controls can be requested.** The container runs
as the unprivileged user 1001 from the image, but with the engine's default
capability set, `NoNewPrivs` off and a writable root file system. The
boundary is therefore the per-user virtual machine (nothing from Windows is
mounted into it), the non-root guest user, and what the image leaves behind.
Mitigations that do not need a flag: every stage of the image strips setuid
and setgid bits at build time (`su`, `mount`, `passwd` and the rest lose them;
see [image stages](#image-stages-and-the-bundled-light-image)), there is no
`sudo`, the worker and every launcher run as 1001, and the `/tmp` and `/run`
tmpfs mounts keep `nosuid,nodev`. Nothing at run time checks that an image
passed by a caller was built this way. The VM is
shared by every Pal computer of the same Windows user. Use Docker or Podman
for any use that gives a Pal code you do not trust to run with its own
privileges. The adapter sets no CPU, memory or process quotas, as with Podman.

### Behaviour worth knowing

- Cold start of the session's virtual machine takes about 10 seconds after a
  restart; a warm start is about one second. The default 60-second readiness
  deadline covers it.
- `stop --time 10` waits up to 10 seconds for a process that ignores SIGTERM.
- Space freed inside the session is reused, not returned to Windows
  (`storage.vhdx` does not shrink).
- Exec-style bidirectional stdin is unreliable above a few megabytes on wslc.
  The provider never uses it: all guest traffic is HTTP on the published ports.
- wslc depends on the organisation allowing WSL containers
  (`AllowWSLContainer`). Where that is off, the provider reports
  `blocked-by-policy` and nothing else; there is no fallback engine.
- Only 64-bit x86 Windows has been verified. Windows 10 (build 19045) works
  on the verified machine; Microsoft gives no support guarantee for it.

The unit and integration tests drive this engine with a stand-in `wslc`
executable and a local HTTP worker, pinned to output recorded from wslc
3.0.1.0.

## Setting up a Windows PC

The provider never installs an engine, starts a machine, builds or pulls an
image. Setting up a machine is a separate, consented operation owned by the
application: `@namzu/sandbox/local-virtual-computer/setup` inspects the PC,
plans what is missing and runs that plan only after the person agrees.
Namzu Desktop does it from the Pal computer row; the CLI from
`namzu computer setup`. The contract is `setup/contract.ts`.

- **Readiness.** `inspectWslcReadiness` answers one state, the first that
  applies, in this order: `unsupported` (not Windows x64 build 19041 or newer),
  `blocked-by-policy` (`AllowWSL` or `AllowWSLContainer` is 0 under
  `HKLM\Software\Policies\WSL`; absent means allowed), `restart-pending`,
  `platform-off` (Virtual Machine Platform: the `HNS` and `vmcompute` services
  exist; on Windows 10 also the `LxssManager` service), `wsl-missing`,
  `wsl-outdated`, `sdk-mismatch`, `virtualization-off`, `image-missing`,
  `ready`. It reads the WSL version from the first `x.y.z.w` on the first line
  of `wsl.exe --version`, which is UTF-16 and localised, never from a label.
  It also reports every fact it read, so a plan can use them all. The
  processor type is the PC's (`PROCESSOR_ARCHITEW6432`, else
  `PROCESSOR_ARCHITECTURE`: `AMD64` is x64, `ARM64` is arm64), not the Node
  build's `process.arch`, and wslc is looked for under `ProgramW6432` before
  `ProgramFiles`.
- **Every probe has its own time limit.** `reg.exe`, `sc.exe`, `wsl.exe
  --version` and `wslc version` get 10 seconds, PowerShell (the hypervisor and
  boot-time checks) 15, and the command that starts the wslc session 60. The
  limit aborts the runner's signal and stops waiting, so a stuck tool cannot
  hold an inspection. A timed-out service, hypervisor or `wsl.exe` check
  becomes an `unknown` fact, and so does a timed-out registry read of a policy
  value (read as "not set"). Where the
  state cannot be decided (`wslc version` or the session probe timed out, or
  the engine failed with something unmapped) the inspection throws a
  `LocalComputerSetupError` with a plain message and no code, which the CLI and
  Desktop show as "could not check" with Details. An unmapped failure of the
  session probe is never read as `image-missing`; only the engine's own
  not-found answer is (the not-found code, or a bare exit status 1 with no code,
  which is how wslc 3.0.1 says it; a signal kill, another status or a command
  that did not start is not).
- **Without a probe it never starts a virtual machine.** `wslc version` does
  not start the session; `wslc list`, `ps` and `image` do. So by default
  `image.loaded` comes from `<stateDirectory>/image.json`, which setup writes
  after a successful load, and `sdk-mismatch` and `virtualization-off` from a
  failed session start cannot be seen yet. With `probeSession: true` it runs
  `wslc image inspect`, which starts the session if it is stopped, and maps
  the engine's refusal to those states (`0x80370102` is `virtualization-off`).
  Without a probe, `virtualization-off` means that no hypervisor runs although
  the platform is on and Windows reports no restart pending: when the
  hypervisor is absent and Virtual Machine Platform is on, readiness first
  reads Windows' own markers that need no administrator
  (`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based
  Servicing\RebootPending` and `...\WindowsUpdate\Auto Update\RebootRequired`)
  and reports `restart-pending` (with no `restart` record of Namzu's own) when
  either exists, because a PC that has not restarted since the platform was
  turned on outside Namzu has no hypervisor yet. `reg.exe` exits 1 both for an
  absent key and for one it may not read, in every language, so a key is only
  "absent" when an ancestor's listing does not name it (the check climbs past
  parents that are absent too, such as a missing `Auto Update` key, and gives
  up only at a hive root or an ancestor it cannot read); a marker that cannot be
  read (denied, or no answer in time) makes the inspection throw the plain
  "could not check" error rather than claim `virtualization-off`. With a probe
  the markers are not consulted at all: the session's own failure decides, and
  `0x80370102` stays `virtualization-off` even while Windows has a restart
  pending.
  A policy read (`AllowWSL`, `AllowWSLContainer`) that does not answer in time
  is "could not check", never "not set".
  A restart record that exists but cannot be read (anything but "not there")
  is dated by its file instead: a boot after that date ends it like any record,
  and an earlier one leaves `restart-pending` with no remaining steps known. If
  the file cannot even be dated, the inspection does not throw: it reads
  `restart-pending`, with no `restart` record to report and no remaining steps.
  A record that exists while the boot time cannot be fetched stays
  `restart-pending`; a record that cannot be
  deleted after a restart is ignored. On the verified PC an inspection without a
  probe takes about 0.3 seconds (three runs: 287, 249 and 257 ms); with a probe, 10.2
  seconds for the first one (the session was stopped) and 0.3 seconds once it
  runs.
- **Plan.** `planWslcSetup` turns the facts into steps (`download-wsl`,
  `enable-windows-features`, `install-wsl`, `restart`, `load-image`), each with
  its download size, rough time, whether it is elevated and whether it may need
  a restart. It looks at every fact, not only the headline state: WSL missing
  or below the floor gives download and install, Virtual Machine Platform (or
  on Windows 10 the optional component) off gives the enable step and a
  restart after the elevated steps, an image that is not loaded gives
  `load-image` last. A pending restart gives `restart` first, then what is
  left. A state Namzu cannot change (`unsupported`, `blocked-by-policy`,
  `virtualization-off`, `sdk-mismatch`) and a missing image with no bundled
  archive (`image-unavailable`) give no steps and say why in `blocked`. Every
  elevated step of a plan runs in one elevated process, so a plan causes at
  most one Windows permission prompt. The plan `id` is a SHA-256 of the state,
  the steps, the pinned WSL version and the manifest digest, not of the time.
- **The image ships with Namzu.** The application carries
  `resources/pal-computer/manifest.json` and the archive named in it
  (`local-computer/build-image.mjs` writes both); nothing is downloaded for
  the image. `loadWslcImage` validates the manifest (an `imageRef` of
  `namzu-local-computer:<revision>`, a file name with no path), skips
  everything when the engine already holds the image, checks the archive's size
  and SHA-256 (reporting bytes as it reads), runs `wslc load -i`, then checks
  that the loaded image's id and its `org.namzu.local-computer.protocol` label
  are the manifest's and records `{ imageRef, imageId, loadedAt }` in
  `image.json`. On the verified PC loading the 323 MB archive into an empty
  store took 3.2 seconds including the checks, so the plan's estimate is about
  5 seconds plus the archive at 150 MB/s. The size is compared with the
  manifest before a byte is hashed, so a short file fails at once. There is a
  gap between the hash and `wslc load`: a process of the same user could swap
  the archive in between. The check after the load (the loaded image's id and
  protocol label must be the manifest's) catches a different image, but the
  swap is not prevented, and this is accepted because anything running as the
  person can already run `wslc` itself.
- **Consent.** `runWslcSetup` takes `{ planId, approvedAt }`, inspects the PC
  again with the probe and refuses with `plan-changed` (carrying the new plan)
  when the plan it would run is not the one the person saw. Because it probes,
  a plan shown from an inspection without a probe can differ from the one
  `runWslcSetup` sees (the engine may disagree with the record), and the
  application shows the new plan then. It then runs the steps in order and
  reports progress; the elevated steps go in one call. A refused permission
  prompt ends as `cancelled`, an account that cannot elevate as
  `needs-administrator`, a failed step as `failed` with the step, a stable
  code and a plain detail. When setup finishes it inspects once more:
  `ready`, or `blocked` for virtualization, policy or an engine mismatch the
  last inspection found, or `failed` with `engine-failed`.
- **Restart.** When the elevated process says Windows needs a restart, setup
  writes `<stateDirectory>/restart.json` (a temporary file renamed over it, so
  a reader never sees half of one; `image.json` is written the same way, and a
  write that dies before the rename leaves the old file whole) with the steps still to run, asks Windows
  to open Namzu once at the next sign-in when the caller gave a
  `resumeCommand`, and returns `restart-required`. Readiness holds the state
  at `restart-pending` until Windows reports a boot later than the record,
  then deletes it.
- **The elevated step.** Turning on Windows features and installing WSL need
  an administrator, so `runElevatedWslcSteps` runs both in one process. It
  starts Windows PowerShell, a Microsoft-signed program, through
  a launcher that asks Windows for administrator rights (`ProcessStartInfo`
  with the `runas` verb, so a declined prompt surfaces as a Windows error 1223
  directly), and gives the elevated copy a fixed script through
  `-EncodedCommand`; there is no script file or helper program anyone could
  edit or that Windows would name as an unknown publisher. Windows shows its
  own permission prompt once (a standard user is asked for an administrator's
  password), and the prompt names Windows PowerShell. The launcher and the
  `whoami` check run with the Windows `System32` folder as their working
  directory (and the launcher sets the elevated process's `WorkingDirectory`
  to it), so nothing is loaded from the folder the caller happened to start in. Inside, only Microsoft
  tools run: `dism.exe /online /enable-feature /featurename:VirtualMachinePlatform
  /all /norestart` (plus `Microsoft-Windows-Subsystem-Linux` on Windows 10,
  build below 22000), and `msiexec.exe /i ... /qn /norestart /l*v` for the
  package. The steps, the package path (absolute, inside the setup directory,
  ending `.msi`, no quotes or line breaks) and its digest are checked before the
  script is built, and reach it only as single-quoted literals. Both scripts
  take the system folder from the operating system (`[Environment]::SystemDirectory`),
  reset `PATH` and `PSModulePath` first, and the launcher is started with an
  allow-listed environment: `SystemRoot`, `windir` and a `PATH` of the real
  `System32` folder, plus `ComSpec`, the user and profile names and folders,
  `ProgramData`, `ProgramFiles*`, `PROCESSOR_*`, `NUMBER_OF_PROCESSORS`, `OS`,
  and `TEMP`/`TMP` only when they point under the user profile. Every other
  variable (runtime profiler and startup-hook variables, `__COMPAT_LAYER`,
  `PATHEXT`, module paths) is dropped, so an environment the caller inherited
  cannot choose which program or library runs elevated. A value stored for the
  person in the registry (`HKCU\Environment`) reaches every process they start
  and cannot be defended against from Node. The Windows folder must be a drive
  root followed by `Windows` or `WINNT`; on a PC where it is named otherwise the
  launch fails (`elevation-failed`) rather than run a program from a folder the
  environment named.
  The elevated process never writes where a standard user can write: it creates
  a new folder `<Windows>\Temp\namzu-wsl-<random id>` with `New-Item` and no
  `-Force`, so a name that already exists fails (code 23) instead of being
  adopted. It then applies an access list only administrators can change (the
  person who started setup may read it) and reads it back before writing
  anything: the owner must be Administrators or the system account, the list
  must be protected from inheritance, and nobody else may hold more than read.
  It refuses a package that is a link and a `pkg`, log or progress file that
  already exists, copies the package into a subfolder nobody but
  administrators can enter, checks its SHA-256 there against the pinned digest
  and installs that copy, so the file cannot change after the check. The progress lines
  (`elevated-progress.jsonl`) and the installer log (`wsl-install.log`) are
  written into that folder; the caller reads progress from it while it waits
  and turns it into progress events. The folder, small unless the installer log
  is, stays after the run because the caller cannot delete it. The encoded
  elevated script is held under 16,000 characters (about 13,600 today). A launch with the full-size argument and
  no `runas` verb was measured to start (up to 30,000 characters); the `runas`
  launch itself, a real decline and the exit codes still need a run on a clean
  Windows VM. A launch that fails for any reason is `elevation-failed`, and
  `needs-administrator` is reported only when `whoami /groups` lists groups and
  none is Administrators. Exit codes of the elevated script:
  0 done, 3010 Windows needs a restart, 20 enabling features failed, 21 the
  install failed, 22 the package did not match the pinned digest, 23 the
  protected folder could not be created. They map to
  `ok`, `restart-required`, and `failed` with `feature-enable-failed` or
  `wsl-install-failed`; the failed result carries the Windows exit code as
  `exitCode` for a Details fold; a launch
  that does not start, or code 23, is `elevation-failed`. Declining the prompt
  (Windows error 1223, or a message saying the operation was canceled by the
  user) is `cancelled`, except for an account that is not an
  administrator at all (the SID column of `whoami /groups` has no
  `S-1-5-32-544` row, not even as deny-only), which is `needs-administrator`.
  When `whoami` cannot run the account is not called a standard user. Stopping
  the signal stops waiting and reading progress; the elevated process cannot be
  stopped from here and finishes its steps once the person has approved.
  The trade-off against a separately signed helper program: Windows' prompt
  names Windows PowerShell whatever command it is asked to run, so the prompt
  itself cannot tell setup's fixed script from another PowerShell command a
  process of the same user might start. A signed helper that runs only its own
  steps would. This is accepted until Namzu's code signing is decided.
- **The WSL package.** Setup installs Microsoft's `wsl.3.0.1.0.x64.msi` from
  the 3.0.1 release on GitHub: 367,669,248 bytes (350.6 MB), SHA-256
  `28b1a0d013640a2ac95898ea705fa186e5b4ff767a1c1b49257161bc106599c6`, the
  digest the release reports and the one recomputed from a download.
  `downloadWslPackage` writes `<name>.part`, resumes it with a `Range` request
  after an interruption (only when the answer's `Content-Range` starts at the
  byte asked for; otherwise it starts again from zero; a plain 200 answer to a
  resume request overwrites the partial file in that one request), retries network trouble
  and 5xx answers after 1, 2, 4 and 8 seconds (five attempts), fails at once on
  other 4xx answers, checks the digest, renames on success and deletes a file
  that does not match (`download-corrupt`). The image is not downloaded; it ships inside the
  installer.
- **Resume at sign-in.** `registerResumeAtSignIn` writes the value
  `NamzuPalComputerSetup` (REG_SZ) under `host.resumeRegistryKey` with
  `reg.exe add ... /f`, refusing a command that is empty, has a line break or
  is over 2048 characters; no administrator is needed for the default per-user
  `RunOnce` key. Windows removes a RunOnce value as it runs it.
  `clearResumeAtSignIn` deletes it. The value is absent only when the key is
  provably absent (an ancestor's listing does not name it) or the key's listing
  lacks the value; a key the parent lists but the query cannot read, or an
  unreadable ancestor, is thrown, and setup treats a leftover entry as
  harmless.
- **Idle.** `stopIdleWslcSession` asks `wslc system session list` (which does
  not start a session) whether the default session, the one wslc names
  `wslc-cli-<user>`, runs; if not it answers `not-running`. Otherwise it lists
  running containers (`wslc list -q`, Namzu's or not) and answers `busy` when
  there is one; only an empty list ends in `wslc system session terminate`.
  When it cannot tell what runs it throws and leaves the session alone. A
  container started in the milliseconds between the list and the terminate is
  not caught. On the verified PC stopping an idle session took 0.9 seconds
  and a repeat answered `not-running` in 34 ms.

## Owned guest stdio services

`Sandbox.openStdio` is an optional host API on the local computer lease. It
starts literal `command`/`args` inside that allocation, with guest `cwd` and
explicit guest `env`, never the operator environment or host MCP configuration.
The worker strips its `NAMZU_SANDBOX_*` configuration and token from the child;
the existing same-user guest boundary described above still applies. The method
refuses while the operator owns the computer or the allocation has ended.
Older workers refuse interactive startup before spawning; rebuild the image
and start a fresh allocation to use it.

`SandboxStdioChannel.events` has one async iterator of
`{ stream: 'stdout' | 'stderr', data: Uint8Array }` chunks. It preserves binary
bytes across UTF-8 and transport chunk boundaries and applies bounded
backpressure. `write(data, signal?)` confirms at most 1 MiB of stdin bytes per
call; callers split larger byte streams. It does not confirm an application
request completed. `close()` and `closed` confirm the server's entire tracked
process group ended, using the existing strict execution cancellation protocol.
Unexpected loss of that confirmation fences the allocation. Confirmed idle
server exit retains the computer. The worker advertises a finite maximum server
lifetime, using its existing execution timeout ceiling. Transport-only worker
heartbeats keep a quiet server's HTTP response alive and are discarded before
`events`; they neither reserve control nor settle an outstanding application
request. Rebuild the worker and load the matching runtime together to enable
the interactive protocol, including these heartbeat frames.

An idle server does not hold the device busy. Before each real application
request, a trusted transport calls `beginOperation(signal?)`, which reserves the
control barrier and rechecks the optional host `assertExecutionAllowed` callback.
The callback should check the exact original Pal allocation, generation,
conversation writer and admission; it runs again before each write. Complete
that operation only on its exact positive application reply or when dispatch
was never attempted. Pending operations refuse Take over. Closing a service
with pending operations, losing a write acknowledgement or calling
`outcomeUnknown()` permanently fences subsequent effects and control transfers
until the computer is stopped. A late `complete()` cannot clear that fence.

The MCP adapter must correlate replies and drain queued stdout before treating
confirmed EOF as missing RPC replies. An error reply, cancellation notification
or successful MCP envelope is not necessarily proof that an external Blender or
Godot command stopped. In particular, closing a stdio server cannot cancel an
editor command already handed to a separate application process. Hosts must
classify the application's actual completion and retain uncertainty instead of
replaying a mutable call. This API does not suspend arbitrary guest processes
or revoke independently running application behavior; it provides ownership
barriers over host-admitted operations in the existing local container boundary.
