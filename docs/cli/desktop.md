---
type: Guide
title: Desktop application
description: Local native operator preview, its shared CLI runtime, conversation panes and windows, terminal tabs and the Desktop | CLI switch, folder trust, model choices, approvals and background work.
resource: packages/desktop
tags: [cli, desktop, sessions, permissions, workspace]
---

# Desktop application

The private `@namzu/desktop` application is a native operator preview. It uses
`namzu acp --desktop` as a child process per canonical project. The CLI composes
providers, tools, MCP servers, plugins, policy and the kernel; the app does not
import CLI code or create a second agent execution loop.

## Local Turkish speech

**Settings ▸ Speech** (see [Settings](#settings)) offers Turkish playback through EMA Lightning
1.0.1 on this device; the composer no longer carries a voice control, and **Read aloud**
on a reply stays where it was. **Speech language** selects the synthesis language; it does
not change the model's chat language. This engine supplies one Turkish voice and
runs on CPU. Microphone transcription and automatic voice conversation are not
implemented by this feature.

Speech is disabled initially. **Remove voice…** deletes the downloaded engine and models
(the saved preferences stay, and a running playback or download is stopped or refused first);
the card shows where the voice is stored. **Download voice** explicitly installs an isolated
Python environment below the profile's `local-speech/` directory. An installed
app uses the CPython it carries under `resources/python`; a development run needs
Python 3.11–3.14 already available. Nothing is downloaded or loaded by opening
the application or changing a preference. The model is pinned to the speech model host
revision `7a6ba1ad216bb2f1da9863f80ac8770a6a807632`; both weights and the EMA wheel
are SHA-256 verified. The CPU runtime uses pinned Torch/NumPy/normalizer versions,
and weights load with restricted `weights_only=True`. Desktop uses Chromium's
native certificate/proxy policy for the download. An unsuccessful install rolls
back only its own new runtime directory after its owned process has closed.

**Preview voice** plays a fixed Turkish sample even while the preference is
disabled. Enabling voice adds **Read aloud** to settled assistant replies;
playback starts only when clicked. Replies are limited to 8,000 characters. A
separate Python worker sends mono 24 kHz signed 16-bit PCM in at most 200 ms
frames. No more than two frames await actual WebAudio playback acknowledgement.
Changing conversations, retiring a pane, moving its window ownership, document
reload, Stop or closing the application cancels the exact request and fences late
audio. Each stream belongs to the requesting window; audio is not broadcast to
other windows. Isolated Python explicitly uses UTF-8 so native Windows pipes
preserve Turkish text independently of the system locale. Global voice
installation does not delay conversation transfers or draft flushes.

The resource card separates the 34,389,147-byte model download from the Python
runtime and installed disk size. Worker resident memory, CPU use and first-audio
latency appear only after measurement; unavailable values say **Not measured**.
GPU memory is inapplicable to this CPU implementation. CPU percentage refers to
one core, so multithreaded work may exceed 100%. Measurements exclude Desktop
itself and are not an estimate for another device. **Free memory when idle**
unloads the model after five minutes; disabling that option retains it until
explicit cancellation or application shutdown. Reloading after an unload adds
latency to the next playback.

The [isolated renderer receipt](../../research/local-speech-20261007/artifacts/renderer-proof.json)
checks actual popovers, WebAudio playback acknowledgement, split-pane label
identity, owner cancellation and error visibility with synthetic PCM. Actual EMA
installation/inference and native application activation are separate checks.
The [native playback receipt](../../research/local-speech-20261007/artifacts/native-renderer-preview.json)
records real EMA PCM and WebAudio completion without changing the disabled voice
preference or speaking authored user messages. The
[verification notes](../../research/local-speech-20261007/README.md) separate initial
installation, corrected UTF-8 inference, and observed device resource use.

## Installing and updating

The installer is a per-user NSIS setup built by `electron-builder`
(`packages/desktop/electron-builder.yml`): no administrator prompt, installed to
`%LOCALAPPDATA%\Programs\Namzu`, with a Start-menu entry and an uninstaller. The app is
`Namzu` (`appId` `com.cogitave.namzu`) and its profile stays `%APPDATA%\Namzu`, the
folder the development app already uses, so conversations, drafts and settings carry over
to an installed build. Because the folder is the same, an installed Namzu and a development
Namzu on one account are one instance: starting the second only focuses the first. Test
builds that must not touch a real profile start with `--user-data-dir=<folder>`.

The installed app is self-contained under `resources/`:

- `cli/` is `@namzu/cli` with its workspace and npm dependencies as a flat, link-free
  `node_modules`. `app.isPackaged` makes the app run `resources/cli/dist/bin.js` on
  Electron's own Node (`ELECTRON_RUN_AS_NODE`), exactly as before; an explicit
  `NAMZU_DESKTOP_CLI` still wins. It also carries `node-pty`, the pseudo-terminal binding behind
  [host terminals](#host-terminals): the CLI runtime is outside the app archive, so its native
  files load where they are and no `asarUnpack` is needed. `scripts/installer-after-pack.cjs`
  trims the package to the target's `prebuilds/win32-x64` (about 60 MB to under 3 MB: other
  platforms' prebuilds, every `.pdb`, a Linux build tree and the compiler sources are removed) and
  fails the pack when the package or its binary for the target is missing; `stage-installer.mjs`
  fails earlier on the same condition.
- The app icon is the pixel "N" of the wordmark in phosphor green on a dark rounded tile,
  generated by `scripts/generate-icon.mjs` (`pnpm --filter @namzu/desktop icon`) into
  `build/icon.png` (1024) and `build/icon.ico` (16, 20, 24, 32, 40, 48, 64, 128, 256, each
  drawn on its own whole-pixel grid, never downscaled). `electron-builder.yml` uses it for the
  executable, shortcuts, installer, uninstaller and installer header; the development app sets
  it as the window icon.
- `python/` is a standalone CPython 3.14 from python-build-standalone with `venv`, `pip` and
  `ssl` (the python.org embeddable zip has none of them). Local speech prefers it, then the
  Python Install Manager's `%LOCALAPPDATA%\Python`, then `python.exe` on `PATH`. The release,
  URL and SHA-256 are pinned in `scripts/stage-installer.mjs`, and `PYTHON-BUILD-STANDALONE.txt`
  and `LICENSE.txt` ship beside the interpreter. The pinned wheel and model hashes of local
  speech are unchanged.
  A clean Windows image has no Visual C++ runtime, so torch fails to load `c10.dll`; the
  speech installer therefore also installs the pinned `msvc-runtime` wheel into the venv and
  copies its DLLs into torch's own `lib` folder (the wheel alone is not enough, because the
  venv's `python.exe` is a launcher for the bundled interpreter).

Build it with a staged copy, which `scripts/stage-installer.mjs` writes outside the
repository (it refuses a folder inside it). Run `pnpm -r build` first.

```sh
# WSL or Linux: stage the flat project (under 2 minutes, 260 MB of resources)
node packages/desktop/scripts/stage-installer.mjs "$STAGE"
# Windows: build the installer from the staged copy with Windows Node (about 2 minutes)
cd %STAGE% && npm install --save-exact electron-builder@26.17.0   # once, in a tools folder
node tools\node_modules\electron-builder\cli.js --win nsis --x64 --publish never ^
  --config electron-builder.yml --config.electronVersion=44.5.1
```

`--config.extraMetadata.version=<n>` builds a test version for update tests; never edit the
version by hand. electron-builder drops a `node_modules` folder given to `extraResources`,
so `scripts/installer-after-pack.cjs` copies the CLI's after packing. The result for 0.1.0 is
`Namzu-Setup-0.1.0.exe` (about 179 MB) with its blockmap.

### App updates

The installed app updates itself with `electron-updater` (`src/main/updater.ts`), driven
by a state machine of `disabled | idle | checking | available | downloading | ready | installing | error`.
It downloads on its own unless **Download updates automatically** is off in Settings (then a
found update is `available`: the badge and the profile menu offer **Download**, and nothing is
fetched until it is pressed; turning the setting back on takes an offered update at once),
never installs on quit (`autoInstallOnAppQuit` is off) and never
downgrades. The first check is 30 seconds after launch and then every four hours; a failed
check is quiet (a diagnostic and a "Check for updates" entry in the profile menu, never a
dialog).

An installed build reads its feed from `resources/app-update.yml`, which `electron-builder` writes
from the `publish` block of `electron-builder.yml`: the generic provider on
`https://github.com/cogitave/namzu/releases/download/desktop-latest/` (the rolling release described
under [Releasing the installer](#releasing-the-installer)), with `useMultipleRangeRequest: false`
because GitHub's asset host does not answer multi-range requests. Builds always run with
`--publish never` (the generic provider cannot upload); the files are uploaded by
`.github/workflows/desktop-release.yml`.

The environment can still name a feed, for development and the clean-machine test.
`NAMZU_UPDATE_FEED_URL` names a generic `http(s)` folder holding `latest.yml`; the GitHub provider is
used only when `NAMZU_UPDATE_PROVIDER=github` and `NAMZU_UPDATE_GITHUB=owner/repo` are both set.
An installed (packaged) build accepts an environment feed only on loopback (`localhost`,
`127.0.0.1`, `[::1]`) or the GitHub provider for `cogitave/namzu`, because updates are
integrity-checked but not yet signed; any other value is ignored. A development build
accepts any `http(s)` feed.
A build with neither an environment feed nor a provider in `app-update.yml` has no updater and
shows nothing (`disabled`); Settings ▸ Updates then says "This copy can't update itself. Install the
latest version once to turn updates on." That is every installer built before the feed was baked in:
it needs one manual reinstall, after which updates arrive on their own. Settings reads "Up to date."
or "Update available: version X." for a build with a feed.

A feed that answers 404 for `latest.yml` (the rolling release has no installer yet, or does not
exist) means "no Desktop release published yet": the state stays `idle`, nothing is shown, and only a
diagnostic is written. Any other failure keeps the quiet "Update check failed" behaviour.

Installing is always the person's choice and never interrupts work. **Restart now** runs the
install gate: it is refused while a turn is running, queued or admitting, a permission is
pending, background work reports running, a dialog other than the update dialog is open in
any window, someone typed in the last three seconds, or a Pal computer is open. A refused
restart is remembered and tried again every three seconds until the gate is clear, and
**Later** forgets it; an update the person never confirmed is never installed because the
app went idle. When the gate is clear the app runs its own graceful shutdown (the runtime,
local speech, the computer stream proxy) to completion and only then calls
`quitAndInstall(true, true)`, so the installer never starts over a running runtime. If the
shutdown fails the update stays `ready` and nothing is installed; if the installer refuses
to start after the runtime stopped, the app relaunches itself. Tabs, drafts and settings
come back from the profile after the restart.

When an update is ready a small download button appears above the profile avatar (tooltip
"Update ready — restart to install"; one polite announcement when it first appears).
Clicking it opens a dialog with **Restart now** and **Later**; while installing it reads
"Installing update / Namzu will restart when installation finishes." with a bar that is
indeterminate ("Preparing…", then "Installing…") because the installer reports no progress,
and it ignores Escape. A download in progress shows its real percentage. The desktop
preview (`/preview?update=ready|available|downloading|installing|waiting`) draws every state without
an updater; `research/updater-20261008/shots.mjs` captures them in both themes.

The installer is **unsigned** (no `publisherName`). Windows SmartScreen shows "Windows
protected your PC / Unknown publisher" on the first run; choose *More info*, then *Run
anyway*. Updates are then checked by sha512 only, not by signature.

### Releasing the installer

Desktop versions come from changesets. A change to the app adds `.changeset/<slug>.md` with
`'@namzu/desktop': patch` (or `minor`); merging it makes `release.yml` open the "chore(release):
version packages" pull request, which bumps `packages/desktop/package.json` and writes its
`CHANGELOG.md`. Never edit that version by hand. `@namzu/desktop` is `private`, so changesets
versions it but never tags or publishes it to npm (the config's `privatePackages` default,
`{ version: true, tag: false }`, is what is wanted, so `.changeset/config.json` is unchanged), and
`stage-installer.mjs` copies the version into the installer, so the installer's version is that field.
A version is never reused: the feed would change bytes under a number people already run.

After the version pull request is merged, the owner starts **Desktop release**
(`.github/workflows/desktop-release.yml`, `workflow_dispatch`, refused on any branch but `main`)
with the version as input, which must equal `packages/desktop/package.json`. Three jobs, the same
split as the local build above: `stage` (Linux) builds the workspace and runs `stage-installer.mjs`;
`package` (`windows-latest`) unpacks the staged project and runs the pinned `electron-builder` with
`--win nsis --x64 --publish never` and `CSC_IDENTITY_AUTO_DISCOVERY=false`; `publish` (Linux, the
only job with `contents: write`) checks that `latest.yml` names exactly that version, installer and
sha512, refuses a version already on the feed, creates the rolling release `desktop-latest` once (a
prerelease, `--latest=false`, so the repository's "Latest" stays an npm package), uploads
`Namzu-Setup-<version>.exe` and its blockmap, and uploads `latest.yml` last so the feed never names a
missing file. It keeps the installer and blockmap of the previous version (a differential download
needs the old blockmap; without it the app downloads the whole installer) and removes older ones.
The workflow is not part of the `ci.yml`/`release.yml` gate parity.

The installer is unsigned, so anyone who can write to that release can ship an update to every
install; restrict who has `contents: write`, and sign the installer before wide distribution.

### Updates to the programs Namzu works with

Namzu Desktop updates through the state machine above. Codex CLI, the second external engine
(`claude-code`) and a standalone `namzu` on `PATH` are other people's programs, installed by other means, so they have a separate,
smaller mechanism in `src/main/engine-updates.ts`: it finds out that one is behind, and when the
person clicks **Update** it runs that program's own update command in a terminal tab they can
watch. It never installs by itself.

**What is checked.** For each program Namzu runs `<program> --version` directly (no shell, no
PowerShell; an npm `.cmd` shim goes through Command Prompt on one fixed line, because Node will not
start it otherwise; 8 seconds, hidden window) and asks the registry for the package's `latest`
(`GET https://registry.npmjs.org/<package>/latest`, only the `version` field, only a plain
`x.y.z`, never an alpha): `@openai/codex`, `@anthropic-ai/claude-code`, `@namzu/cli`. The first
check is 30 seconds after launch, then every four hours, and a check that finds the cache
(`engine-updates.json` in the profile folder, `checkedAt` per program) newer than four hours skips
the network at launch. Offline, a timeout or an answer that is not a version is quiet: the last answer
stays, nothing is shown, and an answer older than seven days never produces a badge. Installed
versions are read at launch without waiting for the network. `NAMZU_ENGINE_REGISTRY` names another
registry base (a packaged app accepts only loopback), and `NAMZU_ENGINE_FIRST_CHECK_MS` (at most 30,000)
shortens the first delay; the end-to-end flows use both with a stand-in registry.

**How each was installed** is read only from where its program is, never guessed:

| Method | Where | The command a click runs |
| --- | --- | --- |
| `npm-global` | under `%APPDATA%\npm`, the npm prefix's `bin`, a `node_modules/@openai/codex` (and the other two packages) after following links, or a Windows `.cmd` shim that names the package it starts (so a custom prefix is read too) | `npm install -g <package>@latest`, with `npm.cmd` on Windows, never `npm.ps1` |
| `native` | `claude-code` in `~/.local/bin` | `claude update` |
| `standalone` | Codex under `~/.codex/packages` | `codex update` |
| `bundled` | the app's own command line, when no `namzu` is on `PATH` | none: it updates with the app |
| `unknown` | anything else (Homebrew, winget, scoop, a download) | none: the command is shown with **Copy** |

**The update.** A click (never anything else) is refused while that program has a reply running,
queued or waiting for an answer in a conversation, or has a live engine terminal tab ("Close the
Codex CLI tab first."); nothing is stopped for the person. Otherwise Namzu ends its own idle
servers for that engine (`namzu/harnesses/release` to each project's host, because a running
`codex.exe` cannot be replaced on Windows), then opens a shell tab titled **Updating Codex CLI** in
the pane and a trusted project in front (the host starts terminals in a project folder, so none open without one; the
row then shows the command with **Copy**), running exactly that command, and leaves Settings so the output is
what is on screen. The tab stays after the command ends so its output can be read. When it ends
Namzu reads the version again, drops every stored model list of that engine, emits
`model-catalogue-updated` so open pickers read again, and toasts "Codex CLI updated to 0.162.0".
An exit code of zero with the same version reads "Updated, but the installed version is still
0.154.0. Another copy may be earlier on PATH (<path>)."; any other end reads "Update failed — see
the terminal" with a **Try again**; on Windows output naming `EBUSY` or `EPERM` says to close other
Codex windows and retry, and `EACCES` says the install needs administrator rights. Namzu never
elevates and never changes the npm prefix. Open conversations keep running their old process until
they restart, and the row says so.

**Where it runs.** The update tab starts in a trusted project's folder (the terminal host refuses any folder outside a project), where npm still reads that folder's `.npmrc`; an npm update therefore passes `--registry=` with the registry the check used, which a project file cannot override. One update runs at a time, and the engine is checked for activity again after its servers stop.

**Where it shows.** Settings ▸ Updates lists the three programs under the app's own row (name,
`installed → latest`, how it was installed as a muted note, the command a click will run, and
**Update**, **Updating…**, **Up to date** or **Check failed**). The rail's download button appears
when any program is behind, labelled "Updates available. Open Settings to update" followed by the names of the programs
that are behind, and opening Settings ▸ Updates; the app's own *ready* state keeps priority over it.
The engine view of the model popup adds "Update available (0.162.0)" under an engine that is behind
and a small dot on the engine chip. Once per new version a quiet toast says "Codex CLI 0.162.0 is
available" with **Update…**, which opens Settings ▸ Updates; which window announces is decided in
main, so two windows do not both toast. The renderer API is `engineUpdates()`, `checkEngineUpdates()`,
`updateEngine({ engine, groupId, projectId? })` (the command always comes from main, never from the
window), `claimEngineUpdateAnnouncements()`, `onEngineUpdates` and `onEngineUpdateNotice`.
Screenshots are in [`research/engines-20261009/`](../../research/engines-20261009/).

### Clean-machine test

`research/windows-sandbox-20261008/run.sh <v1.exe> <v2.exe>` tests the installers in a fresh
Windows Sandbox (6 GB, no GPU, networking on, an installer folder mapped read-only and a
results folder writable). It copies the inputs to `C:\namzu-sbx`, opens the sandbox, waits for
`done.json` and closes it. Inside, `run.ps1` installs v1 silently (`/S`) and
`driver.cjs` runs under a renamed copy of the installed Electron as plain Node, drives the app over
CDP and writes one JSON receipt per check plus screenshots: first launch, opening and trusting
a folder, a free Zen reply with no key, local speech (install with the bundled Python, then
one sentence checked for 24 kHz mono 16-bit PCM, contiguous frames, duration and level), the
updater (a static feed of a v2 build served from inside the sandbox, found and downloaded by v1, installed
through the real badge and dialog, the app relaunched as v2 with its draft and projects intact)
and a silent uninstall that keeps the profile. `make-feed.mjs` writes the generic
`latest.yml` for a build; a v2 is the same build with `--config.extraMetadata.version`.
The driver runs from a copy because the installer stops and replaces every `Namzu.exe`.

## Run from source

Install and build the workspace, then launch with the checkout's built CLI:

```sh
NAMZU_DESKTOP_CLI="$PWD/packages/cli/dist/bin.js" pnpm --filter @namzu/desktop start
```

Without `NAMZU_DESKTOP_CLI`, the app runs the installed `namzu` command. It checks
for desktop host support at initialization and reports an incompatible CLI.
`NAMZU_DESKTOP_CLI` is a main-process executable entry setting, never a renderer
argument or model input. On Windows the installed `.cmd` shim is invoked through
a fixed `namzu acp --desktop` command; project paths are passed as process cwd.
Closing first ends CLI stdin so session and guest cleanup can finish. After a
five-second grace period, Windows force-stops only the still-live owned CMD
process and its descendants with `taskkill /pid /t /f`, then awaits process
closure. It never kills by executable name. A failed OS stop rejects and can
be retried; an already-exited wrapper PID is never targeted. Protocol output
and retained stderr diagnostics use separate UTF-8 stream decoders.
The desktop retains ownership when shutdown fails, blocks new work and reports
the failure. On Windows and Linux its final window stays open until shutdown succeeds;
close it again to retry. A disconnected metadata or project client remains in
the shutdown set until its process closure is confirmed.
The app is not yet distributed through native installers or auto-update.

On Windows PowerShell, select the built CLI entry without a Bash assignment:

```powershell
$env:NAMZU_DESKTOP_CLI = (Resolve-Path .\packages\cli\dist\bin.js).Path
pnpm --filter @namzu/desktop start
```

On Windows, the desktop-owned Node child selected by `NAMZU_DESKTOP_CLI` adds
`--use-system-ca` before the entry point when its embedded Node supports that
flag. This includes Windows trusted roots alongside Node's bundled roots and
inherited `NODE_EXTRA_CA_CERTS`; certificate and hostname verification stay
enabled. An explicit CA option in inherited `NODE_OPTIONS` is preserved, and
unsupported runtimes keep their existing trust behavior. The installed `namzu`
command and standalone CLI trust defaults are unchanged.

Pal computers inherit the CLI's local-engine settings from this native host.
The default is Docker. If this device uses an existing local Podman machine,
set `NAMZU_PAL_COMPUTER_ENGINE=podman` and its verified local machine/connection
settings before launching, as described in [Local Pal computer](../sdk/local-pal-computer.md).
Starting a renderer development server alone does not configure that native
host or start a Pal computer.

### Native Windows development snapshots

A copied development runtime must contain the complete CLI dependency graph.
Copying only the CLI and SDK while retaining older provider package junctions
can load two SDK registries and fail with `Unsupported provider type: zen`
before a model request starts. Keep one source checkout and deploy its built
main process, preload and renderer together; preserve the application's userData.

The research helper `research/runtime-desktop-20260930/prepare-windows-reused-consumer.mjs`
accepts a built WSL checkout, an existing compatible native consumer fixture and
a fresh Windows Temp snapshot directory. It copies every Namzu package in that
fixture, derives runtime assets from each package's `files`, and requires native
external dependency versions matching the checkout's installed dependencies.
`--check` performs preparation checks without writes. `--refresh-unlinked` is
limited to a matching snapshot that has not yet acquired dependency links.
Run the generated `link-native.mjs` using native Windows Node: it materializes
external package files, rebuilds internal junctions inside the new snapshot and
refuses split SDK roots. The result is a local runtime fixture, not an npm
installation or a native distribution. The
[coherence receipt](../../research/runtime-desktop-20260930/artifacts/development-source-consolidation-native-windows-safe-20261005.json)
records the actual Windows graph and isolated Zen registration check.

### Diagnostic logs

The native host records startup, unhandled main-process failures, renderer
load/process failures and error-level renderer console reports, CLI transport
and stderr diagnostics, failed CLI
requests, unavailable capability notices, and failed IPC calls. An error
caught and displayed by the interface is still recorded at the native IPC
boundary. Pending observation requests cancelled by an explicit owned transport close are
expected cancellation; unexpected exits and OS shutdown failures remain failures.
An asynchronous turn whose successful RPC envelope carries `stopReason: error`
also creates a failure record, without recording its returned history.

Use **Help → Open diagnostic logs** in the native application menu, or
**Ctrl+Shift+L** (**Cmd+Shift+L** on macOS). The files
are `logs/desktop.ndjson` and `logs/desktop.previous.ndjson` inside Electron's
normal application `userData` directory. A trusted native renderer can also
call `window.namzu.diagnostics()` to inspect the exact file paths and whether
storage is available. This method is absent in the browser design preview.
No log destination override is taken from the renderer.

Each NDJSON record has a fixed event/body, severity, timestamp, process
instance and namespaced attributes. CLI request failures include the fixed
method, connection and request correlation, numeric RPC code when supplied,
and recognized failure reason or OS code. For example,
`docker-engine-or-image-required`, `podman-machine-stopped`,
`provider-not-configured` and `model-catalogue-unavailable` identify actionable
failures. Unrecognized errors retain their safe type and `unclassified`
reason. Raw stderr, error messages/stacks, prompts, tool inputs/results,
credentials, project paths and URLs are never stored. Renderer reports include
only a fixed failure kind and numeric source position.
Startup records include the platform and selected local engine, including
`default-docker` when `NAMZU_PAL_COMPUTER_ENGINE` is absent.
Complete CLI stderr lines retain the SDK structured or standard pretty logger's
recognized `debug`, `info`, `warn` or `error` level. Unknown stderr is a diagnostic
warning. INFO/debug output has no failure attributes; the words `JSON` or
`protocol` alone do not establish a protocol failure. Split UTF-8/line chunks
are reassembled with a bounded buffer, and a final partial line is recorded on
stream closure. Raw body and attribute content still remain excluded.

An external engine's start is recorded as `engine_timing` at INFO: the engine
(Codex or the second external engine), the step (`open` or `models`) and, as whole
milliseconds, `spawnMs` (until the operating system had created the process, where
antivirus scans show), `initializeMs`, `modelListMs` and `totalMs`, with `reused`
when a process that was already running served the step. The CLI measures them and
returns them with `namzu/harnesses/list`, `namzu/harnesses/select` and
`namzu/providers/models`; main records them and ignores nothing else in those
fields. No path, model id or account detail is part of a record.

A model settings read superseded by an owned provider or engine selection is
still rejected by the metadata fence. It records `ipc_superseded` at INFO with
the method, request correlation and fixed `conversation-settings-superseded`
reason. Only the main process's typed selection invalidation receives this
classification; connection, project, authorization and provider failures remain
errors, including wire errors with a matching name or message.

Each file is bounded to 512 KiB; rotation retains one previous file. A burst
above 200 records of one event per second produces one rate-limit record, then resumes in
the next second. Files/directories request owner-only POSIX permissions;
Windows uses the application's userData directory permissions. Redirected log
files/directories are refused; each write checks the original directory's
canonical identity again. Storage failure remains visible through the
diagnostic metadata and cannot replace the original operation failure.

### Live interface development

The development CSP permits the exact local reload connections and local Blob
workers used by Vite reconnection. The bundled renderer retains its production
policy.

```sh
NAMZU_DESKTOP_CLI="$PWD/packages/cli/dist/bin.js" pnpm --filter @namzu/desktop dev
```

The development runner serves the renderer through a loopback Vite server,
watches the native TypeScript code and opens Electron against that server.
Renderer changes appear automatically without rebuilding the application.
CSS updates keep the current page; component updates may reload it. The native
host still owns conversations, admitted work and drafts during a renderer reload.

For a separately launched native window, `pnpm --filter @namzu/desktop dev:renderer`
starts the server and native compiler without launching Electron. Set
`NAMZU_DESKTOP_DEV_URL=http://127.0.0.1:5173/` in that window's host environment.
Only unpackaged development hosts admit an explicit HTTP loopback root URL.
Packaged applications load their bundled renderer; native IPC keeps its sender
and main-frame checks in either mode. The development CSP permits the local
reload connection; the bundled renderer retains its restrictive production CSP.

Open `http://127.0.0.1:5173/preview` in a browser to review the same interface with
clearly labelled sample projects and conversations. This development-only
preview keeps changes in memory and has no access to the CLI, credentials,
filesystem or live tasks. Use the native development window for actual work.

Add `?connect=slow` to hold the first sample project in connecting for 3 s,
`?connect=error` to fail it (Try again fails again) or `?connect=untrusted` to open
it ready but not yet trusted, so each project state can be reviewed.

### Opening a folder

A project starts as not trusted and connecting; the CLI reports its real trust
only after it starts, which can take seconds on Windows. While connecting the
stage keeps the sidebar and tabs, stays blank for the first 400 ms, then shows
a small spinner and "Opening *name*…"; the trust gate never appears for it. "Make
this your workspace" with **Review folder access** shows only for a project that
connected and is genuinely not trusted. A folder that fails to connect shows
"Couldn’t open this folder", the error text once and **Try again**, which
reconnects it through the same path as the banner's Reconnect. Pal and chat
workspaces keep their previous failure handling. The main process still trusts
nothing early. [Proof](../../research/project-connecting-20261008/README.md).

Folder access is asked inside the app, never in a native message box. A folder
chosen in the app's own folder picker is trusted by the main process right after
the pick with no second prompt: the pick is the consent, and main captures it,
never the renderer. A broad folder is the exception: a drive root, the home
folder itself, or a system folder (the Windows directory, Program Files and
ProgramData with everything under them, the roaming and local application-data
roots, `/etc`, `/usr` and the like; the list is data in
`src/main/folder-access.ts`). Main does not trust it. It answers with the
project plus a `broadFolder` kind and a one-time token bound to that exact
canonical path and window, valid for five minutes. The renderer shows an in-app
dialog ("This is your whole drive … Prefer a project folder.") with **Allow
anyway** and **Choose another folder**; **Allow anyway** sends the token back to
`trustProject`, and main trusts only when the token is unspent, unexpired and
matches the path and the window. A used, expired, foreign-window or
other-path token is refused. A folder that is already known but untrusted
(restored, opened by path, created by the CLI) keeps the gate; **Review folder
access** opens the same in-app dialog, and its confirmation is consent captured
by the renderer, since the person already added the folder. A known broad
folder is answered with a token first, so it takes the broad dialog too.

A picked folder that holds settings able to run code on their own gets the same
kind of in-app consent. Main looks, without running anything, at
`namzu.config.json` (the sections `hooks`, `mcpServers`, `plugins`,
`permissions`, `permissionChecks`, `sandbox`, `web`, `additionalDirectories` and
`profiles`; an unparseable file counts), and at `.namzu/plugins` and
`.namzu/commands` (links are not followed; the list is data in
`src/main/folder-settings.ts`). When it finds any, the pick does not add the
folder: main answers with a pending folder (`pending: true`) that carries
`riskySettings.found` and a one-time token bound to the canonical path and the
window, valid for five minutes. The dialog "Trust this folder?" names what was
found ("hooks, 2 MCP servers, 1 plugin in .namzu/plugins") and says folder
settings can run code automatically, even without a model request; **Trust
folder** sends the token to `trustFolder`, and only then does main open the
folder, trust it and save the project list. **Cancel** adds nothing. A known
untrusted folder with such settings answers its confirmation with a token the
same way, and a broad folder keeps the broad dialog. An ordinary folder is
still trusted at once.

A folder that was trusted but whose automatic settings have changed since asks
again on its next connect; see
[Trust again when automatic settings change](#trust-again-when-automatic-settings-change).

**Add new project** is a two-item menu in the sidebar (empty state and workspace
menu), the File menu, the rail's More menu, the welcome screen, the composer's
project chooser and the command palette. **Start from scratch** has main create
`Documents/Namzu/New project` (`New project 2`, `New project 3`… when the name is
taken; the folder is made without `recursive`, so two windows cannot share one),
run `git init` there when git is on the PATH (a missing or failing git never
fails the creation), trust it (a folder main created is its own consent) and open
it. A failure reads "Couldn't create a new project: *message*". **Use an
existing folder** is the folder picker above, and Ctrl/⌘+O still opens it.

A project that was just added, or selected, and is trusted lands on its home at
once with the heading "What should we work on in *name*?" and the composer
focused, as soon as the composer is enabled; chats and Pal workspaces keep
"What would you like to work on?". A project leaves Namzu
through [Removing a project](#removing-a-project).

## Settings

**Settings** is a page of its own in the main area, like Plugins: the rail's gear, the
profile menu's **Settings…**, the command palette's **Settings**, the File menu's **Settings…**
(`Ctrl+,` or `⌘,`) all open it. The left column lists the sections and the right side shows
one. A section is addressed as `settings/<section>` (`general`, `projects`, `appearance`,
`updates`, `speech`, `about`); the search field at the top matches setting labels,
descriptions and keywords (`src/renderer/settings-model.ts`) and a result opens its section
and focuses that setting. Every control is a real input with a label, groups are
fieldsets, the section list is a `nav`, and the page works at the 560px minimum window.
Screenshots of every section in both themes, narrow, the search, and both removal
surfaces are in [`research/settings-20261008/`](../../research/settings-20261008/).

What it holds, and where each value lives (one source of truth per value):

- **General** — *When Namzu starts*: `Continue where I left off` (default) or `Start on the home
  screen` (see [Starting the app](#starting-the-app)); *Default terminal shell* and *Bring terminal
  tabs back* (see [Terminal tabs](#terminal-tabs)).
- **Projects** — every project (name, path, trusted state) with **Remove…**, and *Ask again when a
  project's automatic settings change* (default on). See
  [Trust again when automatic settings change](#trust-again-when-automatic-settings-change).
- **Appearance** — the theme (light, dark, system). It stays in the renderer's own storage
  (`namzu.appearance`) because only the renderer paints it; it moved out of the profile menu.
- **Updates** — the running version, when the last check finished, the state in words,
  **Check for updates** (one button for the app and for the programs below),
  **Download update** / **Restart to update…** where the state calls for them,
  *Programs Namzu works with* (Codex CLI, `claude-code`, the Namzu command line; see
  [Updates to the programs Namzu works with](#updates-to-the-programs-namzu-works-with)), and
  *Download updates automatically* (default on).
- **Speech** — the voice status, size and location, Download, Preview, Remove and the existing
  options (the same content the composer popover used to show).
- **About** — the Desktop, CLI and SDK versions (read from the `package.json` files beside the
  bundled runtime; unreadable ones read "Not found"), the platform, the data folders with
  **Open**. A folder is opened by kind (`app`, `namzu`,
  `diagnostics`, `speech`); the renderer never names a path. License texts ship in the install folder.

Everything main acts on lives in `desktop-settings.json` in the profile folder, written by
`src/main/desktop-settings.ts`: atomically (temporary file then rename, mode `0600`), validated
on every change (an unknown key or a value outside its set refuses the whole request and
changes nothing), and broadcast to every window as a `settings` event. It is a separate file
because `desktop-conversations.json` rejects unknown keys, so a new key there would make an
older app refuse the file. A missing, damaged or hand-edited file never blocks startup: each
bad entry reads as its default and the next change rewrites the file whole. The typed
renderer API is `settings()`, `setSettings(patch)`, `desktopInfo()` and `openDataFolder(kind)`.

## Starting the app

With *When Namzu starts* on `Continue where I left off` (the default) a launch brings back
the saved windows, panes and tabs, and no frame shows the home screen, the welcome or an
empty composer while a saved tab is on its way back.

- **Before the first paint.** The preload makes one synchronous read, `ipcRenderer.sendSync('namzu:boot')`,
  which main answers only to the authenticated main frame of one of its own windows. The reply
  (`DesktopBoot` in `src/shared/protocol.ts`, exposed as `window.namzu.boot`) holds the settings,
  that window's workspace view, the saved folders as `connecting` placeholders with the ids they
  will connect under, the saved views of the open tabs (used only to learn which folder a tab belongs to; they are never listed as rows, since a row is actionable only once its folder is connected), and `launch`, true once for a window the
  app start created. It is seed data only: the asynchronous reads that follow replace all of it
  by the same sequence rules as before, and a failed or missing reply leaves the old path in
  place. Only the panes mounted by the launch commit seed from it (`src/renderer/startup-restore.ts`);
  a pane opened later, or after a reload, reads live state.
- **Folders still waiting their turn.** The restore reopens folders one after another, so a
  first `projects()` read used to answer "none" and the welcome screen painted. Main now
  registers the folders to reopen (`Operator.expectProjects`) before any window exists and
  lists them as `connecting` until their connection registers; a folder that never registers is
  reported as failed. `listProjects()`, from which `projects.json` is written, never carries a
  placeholder.
- **Skeleton, not home.** While the active tab restores (`restoreDecision`), the pane shows
  a skeleton of a conversation (`RestoreSkeleton`, `data-skeleton="restore"`). The tab opens only
  once its folder is connected, and when that folder failed to open, or is not trusted here, the
  ordinary screen and its explanation take over. A tab whose conversation was archived or
  removed falls back to its project's home.
- **First paint colours.** `public/theme-boot.js`, a classic script that runs before the bundle,
  puts the saved theme's `dark` class on `<html>` from the same `namzu.appearance` key, so the
  first painted frame is no longer light.
- **Start on the home screen.** The saved tab stays in the strip with nothing selected and the
  pane shows its project's home; choosing a tab, or any other open or activate action, ends it
  for that window. A window opened later is never affected.

Measured with the real Electron harness (`instrumentFrames` in `packages/desktop/e2e/harness.mjs`
records every painted frame, and the flow "a restart restores the same tab…" asserts on it), one
project and one conversation, three runs before: the first painted frames were a light empty
page (47–64 ms), the welcome with "What would you like to work on?" (268–291 ms), a blank body
(302–318 ms), the project home (633–670 ms) and an empty transcript with the composer
(875–893 ms), then the conversation (899–914 ms). After: an empty dark page, the skeleton, the
conversation. The conversation itself still arrives when the folder's CLI host is up and has
read the journal; what changed is what is painted until then.

## Trust again when automatic settings change

Trusting a folder in Desktop records a fingerprint of what the folder can run on its own:
the same nine sections of `namzu.config.json` the CLI's project digest covers (a test compares
the two lists), plus a hash of every entry in `.namzu/commands`, `.namzu/plugins`,
`.namzu/skills` and `.namzu/agents`. A file is hashed by its whole content, streamed (not by size
and time), a link records where it points and then what is behind it, and a config of any size is
read. Key order and unrelated keys do not count. A part too large to read (past 64 MiB a file,
256 MiB a tree, or 20,000 entries) is reported changed every time rather than trusted unseen.
`MEMORY.md` is not covered: it is prompt text, not something that runs. The record is
`trusted-folders.json` in the profile folder (`src/main/trusted-folders.ts`): the canonical
path, a digest, one hash per part and a time. It holds hashes and entry names, never contents.

On every connect, main compares the folder's current fingerprint with the record:

- **No record** (a folder trusted before this existed): the current fingerprint is recorded
  and nothing is asked. This is trust on first use, so only later changes prompt.
- **Same**: nothing happens.
- **Changed, and the setting is on** (the default): the folder is shown as not trusted
  (`ProjectView.settingsChanged` lists what changed, such as "hooks changed" or "plugin a.js
  added") and the in-app dialog "Trust this folder?" opens by itself, once per change. It says the
  folder's automatic settings changed since it was last trusted and names them. Until it is
  confirmed, every operator action that needs a trusted project refuses, and the tab is not
  opened. **Trust folder** trusts and records the new fingerprint; **Cancel** leaves it
  untrusted and reopens nothing. A broad folder still takes its own dialog.
- **Changed, and the setting is off**: the record is brought up to date and the folder opens as
  before. Turning the setting off asks for confirmation in an in-app dialog (Cancel is focused first); main
  answers the first request with a one-time token bound to that window and that change, valid five
  minutes, and applies the change only when it comes back with the token, so the renderer cannot
  lower it alone, and turning it back on records every connected trusted folder as it is, so
  edits made meanwhile do not prompt later.

The same check runs again right before work that makes the CLI read the folder: a new
conversation, a conversation's reattach or turn start, and a plugin change. A folder that
changed since connect becomes untrusted at that moment and the work is refused with "This
folder's automatic settings changed". **Trust folder** in the first dialog opens a second one
with the same list in full (the change first, then the hooks, servers and plugins found in the
folder); only that one, issued with a main token, trusts. A Pal workspace is not checked: it lives under the
reserved `<home>-workspaces/pals` root that Namzu creates and trusts itself, and no repository
content is cloned into it.

The gate is Desktop's. The CLI host's own `trust.json` still says the folder is trusted, and
the host is already running in it; Desktop simply does not send it work until the person
answers. A fingerprint that cannot be read is recorded as a diagnostic and treated as
unchanged.

## Removing a project

A project can be removed from its sidebar row (a hover **×** button, and a right-click or
Shift+F10 menu with **Remove project…**) and from **Settings ▸ Projects**. Both ask first:
"Remove *name*?" — "This only removes the project from Namzu. Files on your computer and
existing conversations won't be deleted." — **Remove project** / **Cancel**. Pal workspaces and
the chat workspace have no remove action; a Pal's workspace goes with the Pal.

`Operator.removeProject` refuses a project that is still connecting, and while anything in it is active: a running, admitting
or queued turn, a pending permission, a plugin or engine change in progress, background work
the tracker knows about, or a running or recovery-needed job the host reports. The dialog stays
open and says "A reply is still running in *name*…". When it is idle it, in order:

1. asks the project's CLI host to remove the folder from the trust list
   (`namzu/project/untrust`, below); a failure here refuses the whole removal, so nothing is
   half done;
2. closes the project's CLI connection (the project leaves the table first, so the close is
   not reported as a failed connection);
3. drops the project's row, conversations, tabs, drafts, pins and draft attachments from
   `desktop-conversations.json`, `projects.json` and the open windows, and emits
   `project-removed`, which retires the tabs in every window.

It mirrors what archiving a conversation does to Desktop's own state, so drafts and pins go
with the project. It never deletes files, and it never touches a journal: those live under
`NAMZU_HOME/projects/<slug>` keyed by the folder, so adding the same folder back lists its
conversations again, under a new project id, with no pins or drafts and with the trust
question asked again.

Trust is shared with the terminal CLI (`~/.namzu/trust.json`), so removing a project from
Desktop also stops that folder being trusted for terminal use. `untrustDir(dir)` in
`packages/cli/src/integrations/trust/store.ts` removes only the entry that names exactly this
folder. An ancestor entry (trusting a repository root covers its subfolders) is never touched;
when one still covers the folder the notice says "Removed *name*. The folder is still trusted
through *path*." instead of claiming it was untrusted. A project that was not connected has no
host to ask, and a runtime that predates `namzu/project/untrust` cannot be asked; the notice
says the trust entry was left as it was.

## Persistent Pals

**New conversation** opens an ordinary conversation, including when a Pal or its
computer is selected. It reuses the current or last available trusted ordinary
project, never a Pal control directory. With no such project, the native host
creates a private normal chat context beneath its application data directory.
Only an app-created, unredirected directory with its exact ownership marker can
receive implicit folder trust. This context is not listed under Projects; its
conversations appear in Recents. In a ready trusted context, New conversation
creates an unstarted conversation slot; it starts no model or native engine.
Normal and Pal drafts, attachments and model choices retain separate
owners. Choosing an existing Pal returns to its owned chat.

Owned Pal drafts default to automatic approval for their guest tools, including
when only reasoning effort is selected. Ordinary conversation drafts retain Ask
first. An explicitly saved mode remains selected, including Ask first or Plan;
queued message editing retains the mode captured when that message was sent.
This default is based on the main process's claimed conversation ownership and
does not approve host access. The [Pal execution boundary](pals.md#computer-setup-and-execution)
retains configured denials, pause, takeover and current writer/control checks.

The Home sidebar puts **Create your first Pal** directly below New conversation.
After creation it lists each Pal followed by **New Pal**, without a group
heading for the first three. Four or more Pals appear in a collapsible **Pals**
group. Create more than one Pal with a name, appearance and model from the
actual provider catalogue. Give work and preferences through the conversation;
customization does not require a purpose form. Customize uses the saved revision to reject
conflicting edits. Definitions and
conversation ownership come from the [shared CLI and SDK](pals.md), rather than
renderer storage. Existing conversations keep their original profile revision
for model, purpose and execution policy. Authenticated name and appearance edits
update the next turn's display identity. A conversation's model choice remains
local to that conversation.

Setup begins inside the conversation with a character, greeting, model picker
and invitation to choose a name. These welcome messages are local interface
content; they do not start a model turn or the Pal's computer. Customize opens a
two-column dialog: color and character choices on the left, editable name and a
large animated preview on the right. Save publishes name, model and appearance
together. A failed save retains the choices for retry. Appearance offers three
original characters (Pixel, Sprout and Spark) in five colors. It is part of the
shared SDK profile, so CLI metadata edits and desktop edits survive restart.
Older profiles without appearance display Pixel in green without changing the
stored revision. An unavailable model catalogue leaves setup and customization
usable; the Pal may use the host's configured model when its own model is null.

Opening a Pal requires a ready, trusted CLI connection that reports the same
Pal id and approved workspace. If Windows path resolution changes only letter
casing, the host preserves the profile's stored spelling after verifying that
both paths name the same physical directory. A failed open keeps the profile
available for retry and retains the original metadata error.

Save opens an owned conversation with a stable English introduction from the
original profile revision. It starts no paid inference or guest computer, and
the introduction remains visible through later messages, reloads and renames.
Pal chat presents user messages and completed public replies as chat bubbles.
Explicit final answers supersede unphased parts of the same identified message;
reasoning, commentary and tool narration stay outside the public chat. Actual
Typing, Working and approval-waiting states provide concise progress, and real
errors remain visible. Pal conversations have no separate Activity or Changes
pane. The Pal card summarizes recent actions and reveals completed file changes
inside Outputs. Live and moved panes preserve the admitted tool timeline without
rendering a technical activity list. Current cold history restores public messages,
not old tool receipts, so card summaries describe only the retained view.
Ordinary conversations keep their Activity and Changes panes.

The [native Windows Pal receipt](../../research/runtime-desktop-20260930/artifacts/pal-chat-native-windows-safe-20261005.json)
records two real Zen replies from `space-bunny-free`, saved-name identity,
English introduction, Turkish language follow-up, actual Typing and Working
states, matching messages through full restart and aligned composer centers.
It used a separate owned conversation and retained the existing Pal profile and
draft. Fresh profile customization remains covered by regression tests; this
native run did not start a guest or exercise tools/control. Final native
diagnostics reported no errors. The shared header remained 52px across ordinary
and Pal views; repeat warm samples were 41–62ms, while first cold external-engine
loads took about 1.2s. These are observations from that run, not latency guarantees.

The composer keeps text and its placeholder vertically aligned with its buttons.
Approvals remain readable; their decisions require actual current guest authority.
Once setup saves the profile, the central character disappears. A persistent card on the
right shows its live 3D character, computer, owned recent conversations and
current completed change receipts. The pencil beside the character opens
customization. At an available chat-stage width of at least 720px, the card
reserves its own right column without overlapping the transcript or composer.
It is 240–300px wide, with bounded vertical scrolling in short windows. Below
720px, the same profile becomes a compact identity and computer-status row above
the full-width conversation. Its keyboard-accessible trigger opens the existing
details in an anchored popover; dismissal restores focus, and the full character
scene mounts only with the visible details. The breakpoint follows the actual
pane rather than the browser viewport, so split panes use the same behavior.
A small settings icon beside the Pal's
name opens its communication settings. Planning tasks appear inside this same
card, between Computers and Recent activity, as **Progress** milestones with
reported state icons and a completed-step count whose two numerical values use
small keycap-style capsules; the words between and after them remain unboxed.
Step titles and compact state badges share a row; unresolved dependency context
sits beneath its owning step. Long titles wrap while the state badge keeps its
own column. The count is ordinary text rather than keyboard-input markup.
A finished plan starts folded;
its step titles remain available through the keyboard-accessible disclosure.
Open or failed steps start visible. Dependency labels resolve task subjects;
failed prerequisites remain visible as needing attention but do not invent an
unresolved wait after the runtime treats them as terminal. Pal progress appears
only inside the card, without a duplicate summary above the composer, including
while the profile catalogue loads. Saved Pal view preferences that previously
opened Activity or Changes restore with those panes closed. The Pal route excludes
their DOM and layout column even while its profile catalogue loads.
Recent activity rows are noninteractive summaries; completed file outputs expand
within the card. Empty activity and output sections are omitted. Pal views do not poll for background-shell counts that have no
visible consumer. Ordinary conversations retain their Activity
task list. Pal conversations hide the transcript scrollbar and its reserved
gutter while retaining wheel and keyboard scrolling through a named focusable
conversation region. The existing profile toggle can hide either the full card
or compact row. The computer-tab control uses a monitor icon and a descriptive
tooltip, distinct from the neighbouring new-conversation plus.
Neither empty outputs nor a disconnected computer imply completed work.
Customizing an existing profile preserves the selected
conversation. Its default model applies to future conversations.

The earlier [native responsive layout receipt](../../research/runtime-desktop-20260930/artifacts/pal-card-responsive-native-safe-20261005.json)
records the preceding card design at a 706px chat area, both sides of its former 720px breakpoint,
Activity open on Sıtkı, a wider window, a short window and the existing profile
toggle in a 380px pane.
It preserves the native viewport, profile visibility, messages, drafts, model
settings, workspace placement and computer allocations. The
[current card capture](../../research/runtime-desktop-20260930/artifacts/pal-card-responsive-native-20261005.png)
records its compact width before Communication moved into the settings icon. The earlier
[wide capture](../../research/runtime-desktop-20260930/artifacts/pal-context-layout-wide-native-20261005.png)
records the former separate transcript, Pal card and Tasks columns. The
[settings and tasks preview receipt](../../research/runtime-desktop-20260930/artifacts/pal-settings-browser-proof-20261005.json)
checks the current shared card, hidden-profile reopening, short-window scrolling,
keyboard focus and ordinary conversation behavior using isolated in-memory
fixtures. It makes no model requests or computer calls.
The [native Windows settings and task receipt](../../research/runtime-desktop-20260930/artifacts/pal-card-settings-native-safe-20261006.json)
verifies the real settings dialog, task summary focus/reopening and hidden
transcript scrollbar with wheel/PageDown access to the last message. A renderer
reload preserves the current window, tabs, messages, profiles, model selections,
drafts and computer generations/control. The final view retains the requested
Pal card and closes Activity; other conversations' presentation stays unchanged.
The [earlier native card](../../research/runtime-desktop-20260930/artifacts/pal-card-tasks-native-20261006.png)
records the task list before the Progress milestone presentation. The
[loaded native settings dialog](../../research/runtime-desktop-20260930/artifacts/pal-settings-dialog-native-20261006.png)
shows Sıtkı's existing outgoing message and wake grants for Kiro without changing
either grant.

The customization preview and saved Pal card use locally generated Three.js
geometry, loaded only when needed, with idle motion, blinking and pointer
tracking. Pausing freezes the card's scene; resuming restarts it. Hidden or
offscreen scenes stop rendering. Each visible character holds an exclusive
scene lease. A renderer retains at most two idle scenes for reuse with the same
character, color and size. Detaching a view removes its canvas, stops animation
frames and disconnects its listeners and observers; its idle scene may retain
the WebGL context without drawing. Eviction, invalid contexts and failed
initialization dispose the scene's renderer, geometry, materials and textures.
Reduced motion discards active and idle decorative scenes and uses a static
character with the same selected appearance, as does unavailable WebGL. This
decorative cache does not retain a guest computer connection.

Each Pal requires its own [local guest computer](../sdk/local-pal-computer.md) for tools.
Start computer uses the owning Pal runtime; a missing engine or image produces
an unavailable state with the setup reason. An unpaused Pal can still exchange
text while offline or while the operator controls its computer. These turns
expose no tools or host execution fallback. A later turn can use the actual
ready guest after explicit startup or returned control. Pausing still refuses
new model requests, and checkpoint continuation requires guest authority.
The card's **Computers** section
shows an actual guest thumbnail beside the Pal computer and a separate host row
from the native device's real hostname. Selecting the guest opens a full content
view, with a persistent noVNC framebuffer stream. PNG captures are used only
for the small card thumbnail; the full view does not poll screenshots.
Offline, capture failure and unsupported control remain explicit states; this
view does not simulate installed apps. The bundled guest supplies a real Openbox
desktop, a themed wallpaper, a tint2 dock and Chromium, Terminal and Files launchers.
Chromium's bundled New Tab page shows the clock, web search and 15 installed
application launchers, including Blender, FreeCAD, GIMP, Inkscape and Draw.
The omnibox is blank on home/new tabs; navigated sites retain their normal address.
The bundled extension and a scoped startup check select that page without
rewriting browser policies or the saved guest profile. Short guest
viewports keep all five-column application rows visible; narrow layouts scroll.
The launchers use a guest-only native messaging host with a fixed extension origin
and fixed application commands. Closing/reopening the browser leaves the desktop
running. Existing images need an explicit rebuild and computer restart for these apps.
Guest browser and file tools do not fall back to the operator's device.

The owning pane places ordinary conversations, Pal chat and the Pal's computer
in one tab row. All use equal 220px by 32px frames inside the shared outer header.
That header stays in place when switching between ordinary chat, Pal chat and
computer content. Its height follows the canonical 52px workspace-header token,
with common gutters, so changing the selected view does not move the tab row.
New conversation follows the scrollable tab list. Computer and layout controls
form a separate group aligned to the header's right gutter, including split and
floating chat views. They remain visible when the tab list overflows. The
[native alignment receipt](../../research/runtime-desktop-20260930/artifacts/toolbar-controls-right-native-safe-20261005.json)
checks these views and a narrow window while preserving the live computer,
conversation state and original viewport. Its
[header capture](../../research/runtime-desktop-20260930/artifacts/toolbar-controls-right-native-20261005.png)
shows the spacing between tab creation and the right controls.
Selecting chat returns to its transcript and profile without closing the computer
tab. Selecting the computer shows its live desktop. The computer plus button is
visible only while its tab is closed; an open computer uses its existing tab.
The separate New conversation action remains beside the conversation tabs.
The [native visibility receipt](../../research/runtime-desktop-20260930/artifacts/computer-tab-add-native-safe-20261005.json)
and [header capture](../../research/runtime-desktop-20260930/artifacts/computer-tab-add-native-20261005.png)
verify the current live view without changing the operator's control. Isolated
clones of the actual header check open/closed states, both toolbar roots, narrow
widths and independent panes using the loaded native stylesheet; this check does
not exercise native tab clicks. Closing its tab returns to the same Pal chat and leaves
the guest running. Keyboard arrows move tab focus and Enter selects; closing the
computer restores focus to chat. These selections do not change conversation navigation;
even a pending first send keeps its owning chat when its session is created.
Changing views invalidates pending guest input and control transfers.

The [native Windows unified-tab receipt](../../research/runtime-desktop-20260930/artifacts/pal-unified-tabs-native-safe-20261004.json)
verified one tab list with these equal frames on the same row before the common
header-height correction. Opening an
offline computer view and clicking back to Pal chat preserved the actual
conversation identity without errors. That check did not start the computer
or verify its live stream. The later [native header and activation receipt](../../research/runtime-desktop-20260930/artifacts/workspace-tabs-layout-latency-native-safe-20261005.json)
verified the same header node and stable 52px bounds across ordinary, Pal and
offline computer views. At a 900px viewport the tab list scrolled while New tab
and Pal controls stayed inside the header; native bounds were restored afterward.

Layout controls show chat beside the computer, hide it, or place that same chat
in a small floating window. The split header aligns with the two content panes.
The profile control shows/hides the existing card; in a computer view it opens
above the selected pane. A compact chat button on the full computer opens the
floating chat. Its frame expands from that same corner and shrinks into the
circular launcher when minimized; content fades within the changing frame.
Interrupted transitions continue from their current pixel bounds without scaling
text, and reduced motion settles immediately. Exiting content becomes inert
before its animation finishes. Minimizing/restoring, docking and tab selection preserve the
conversation, composer draft, attachments and model choice. These views do not
create an ordinary conversation. Pal chat uses a compact message composer, with
attachment, model and tool settings under its plus control. Ordinary conversations
keep their existing composer.
The Pal menu provides customization, guarded pause/resume and guarded computer
reboot and Delete Pal. Deletion is also available inside the customization dialog.
Confirmation names the retained data: the saved conversations, workspace files,
profile revisions and persistent volume remain; this is not a storage purge.
Main validates the exact profile revision, refuses active/queued/review/recovery
work and confirms cleanup through the actual owning computer client before
publishing a terminal profile revision. Failed or unconfirmed cleanup keeps the
Pal visible for retry. Confirmed removal retires its projects and conversation
tabs in every registered window. Offline deletion does not initialize a sandbox
provider or start a guest. See [Pal lifecycle](pals.md#storage-and-conversation-ownership).

The native host validates the guest's exact generation and keeps its allocation
bearer private. An Origin-checked loopback WebSocket proxy exposes only an ephemeral,
single-view, read-only ticket. The renderer's CSP permits that exact local port.
noVNC draws changing framebuffer rectangles directly to its canvas without React
state or JSON IPC per frame. The view stays connecting until the visible canvas
has presented its first frame at the allocation's exact geometry; a successful
transport handshake alone never enables guest input. Disconnect immediately disables
input and offers a reconnect action; route/generation changes close the old viewer. Older images
report live observation as unsupported until explicitly rebuilt and restarted.

**Take over** verifies the allocation generation, fences new Pal work, cancels
owned foreground turns and confirms background job termination before requesting
exclusive operator control. A failed or uncertain stop keeps the control change
refused. The view then forwards mouse, drag, scroll, text and keys through native
IPC into that exact guest. The host pointer keeps its normal arrow. Coordinates
exclude letterboxing. Text input follows the keyboard layout, including Unicode
and AltGr; Tab remains host focus navigation.
Rapid input is serialized; adjacent pending text is combined into bounded UTF-8
batches without crossing key or pointer actions. Native menu accelerators are
suppressed only while the controlled guest has keyboard focus. Navigation and
allocation, chat layout and focus changes invalidate queued input. Host chat and
popups never own guest input, and returning focus cannot revive retired queued
actions. Deliberate input retirement is silent; genuine transport errors remain
visible. Worker credentials never enter the
renderer. Captures and delayed status
replies cannot certify another generation or replace a newer control transition.

**Return control** restores Pal authority explicitly. Queued work remains parked;
the button stays available during ordinary input and drains queued input before
handoff. Offline states and actual control transitions still disable it.
Returning control does not start a model turn. A later admitted Pal must capture
a fresh screen before GUI mutations. An already warm paused Pal can be controlled
by the operator without allowing model work. Providers without the optional
arbitration port remain view-only. The [SDK and local provider](../sdk/local-pal-computer.md#exclusive-operator-control)
document the boundary, including guest-process limitations.

The top Pal status reveals Pause/Resume on hover or keyboard focus. The computer
status reveals Start computer over Offline, or Stop computer over Connected,
in the same position; there is no separate start/stop button row in the card.
Connecting is a status without a lifecycle action. A computer requiring stop
recovery reveals Stop computer over Offline before another start is possible.
When no stop recovery is required, unavailable start handlers, including paused
Pals, leave Offline as plain text; disabled stop actions retain their status
instead of showing an actionable label.
Touch layouts show the available action in the same status position. The card
has no separate pause footer.
Stop computer is refused while known turns, queued messages, approvals or
background jobs still own work. Cleanup failures retain a recovery notice and
allow a stop retry. Pausing blocks new admissions, model steps and subsequent
guest operations; it does not itself terminate an already running command.
Customization and pause controls are also guarded while owned work is active.
An unconfirmed background-job stop remains running. Its row displays the
recovery reason and offers Retry stop; only confirmed termination removes that
control. Model status belongs to both the project and selected conversation,
so a delayed landing-page response cannot replace a pinned conversation route.

A model list row may carry an optional `default: true` naming that engine's or provider's own recommended model; the picker marks that row with a muted "Recommended" chip (there is no separate Default row) and its note no longer repeats it. A row may also carry `current: true`, the source's own statement that the model is current rather than an older release: the second external engine marks its alias rows (a row whose id names no version), the Codex engine marks its default row. Codex rows are labelled as the Codex app labels them ("GPT-5.6 Sol"); ids are unchanged.

The native host uses a metadata-only registry connection for saved definitions
and model catalogues. Execution, captures and computer lifecycle requests go
through the Pal's own validated control-directory connection. A new session is
claimed before it is exposed to the renderer. Ordinary project sessions and
another Pal's sessions cannot be adopted. Private control directories are not
listed as ordinary projects or persisted in the desktop's project settings.
The named IPC methods have the same sender checks as ordinary desktop actions;
the CLI's [ACP extension table](pals.md#acp-host-extensions) describes the wire.

### Pal communication management

The small settings icon in the Pal context card opens a settings dialog named
for the currently owned Pal. Its Communication section contains Peers, Inbox
and Activity subscriptions, which use the
existing SDK message policies, durable inbox and activity subscription stores.
Opening or refreshing this panel does not request a model turn or start a
computer.

Peer permissions are directional. The operator can change this Pal's outgoing
send and wake permissions; incoming permissions are displayed separately and
edited from the sending Pal's own view. Disabling sending also disables its wake
grant. A wake grant permits a host to execute a delivery; it does not install an
automatic idle dispatcher. Active Pal turns can receive accepted messages at
their existing safe execution boundaries, and the CLI retains its explicit
finite dispatch operation.

The [actual Sıtkı → Kiro Windows receipt](../../research/runtime-desktop-20260930/artifacts/pal-producer-native-safe-20261006.json)
records a free-model desktop turn using `list_pals` and one `send_pal_message`,
then matches its acceptance receipt to Kiro's durable pending inbox entry.
It preserves the two observed conversations' models, drafts, profiles, tasks,
workspace placement and computer generations, and restores the original
operator control. This producer check does not dispatch Kiro or establish a
recipient answer.

Inbox entries show pending, claimed or recorded delivery metadata. Recorded
means the message entered the durable conversation, not that the recipient
answered or completed a task. Message bodies, private profile context, receipt
internals and journal cursors are omitted.

An activity subscription selects a known owned source Pal and its exact original
conversation, plus a recipient. The currently opened Pal must be one participant.
Creation validates the original tenant and pinned profile, publishes a disabled
subscription, records explicit observation/disclosure/receive/wake consent, and
then enables it. A partial setup remains disabled. Disabling uses the displayed
record revision. Team membership is not implied by either permission type.

Main captures the existing conversation's exact Pal, runtime session and client.
Mutations consume a loaded snapshot token and carry the original expected record
revision; replaced connections and stale views must refresh. Failed or incomplete
reads retain previously confirmed rows with an unavailable notice and disable
editing that section. Older runtimes report unsupported management. The browser
design preview does not manufacture message or subscription records.

The browser design preview supports in-memory creation and customization, and
explicitly reports that a real computer needs the native application. This MVP
does not yet run a resident autonomous loop, Pal Team or external channel adapter.

## Appearance and message display

The app opens in its dark appearance. **Settings ▸ Appearance** offers light,
system and dark; the local choice survives window reload. The
two-row wordmark and phosphor-green accents match the operator CLI. Menu,
panel and message transitions respect the system reduced-motion preference.
In the project and engine pickers the arrow keys only move the highlight; Enter,
Space or a click chooses and closes. Dark-theme muted text, placeholders, control
labels and muted icons use `#979797`, at least 4.5:1 on every dark surface.
The 32px integrated title bar keeps the operating system’s caption controls and
resize frame. Back and Forward revisit the window’s admitted project and
conversation views, with no prompt replay; the adjacent panel control toggles
the sidebar. File provides project and conversation actions; Edit, View and
Window open native menus. Native caption colours follow the chosen appearance.
The left icon rail remains available when the conversation sidebar is collapsed.
The rail contains Home, Spaces, Scheduled, Plugins and More, with Profile at
the bottom. Home owns the chat and blank composer; Spaces reveals the actual
project list. Plugins opens a separate Customize destination with the actual
installed inventory in its sidebar and a searchable two-column list in the main
area. Public and Personal are separate tabs: Personal includes installed plugins
from both project and user locations; Public reads separate catalogue entries,
never installation scope. The native desktop has no public catalogue connection
yet and reports that explicitly. The design preview supplies labelled sample
catalogue entries. Compact rows place an icon, name and description beside an
actions menu containing exactly Try now, Manage and Uninstall.
Clicking a row or an installed name in Customize opens a separate plugin detail
page, with a breadcrumb back to Plugins, the complete description and an
Information section. Installation location, version, status, saved startup
settings and errors come from the actual installed inventory record. Public
details show catalogue metadata without claiming installed or startup state.
The existing live
enable/disable control retains the runtime's restrictions. Breadcrumb Back and
Escape retain the list's collection, search and restore focus. Installation
scope remains metadata in Personal rather than a catalogue category.
Long list descriptions wrap within two lines; their complete text remains in
details. Search uses a rounded field. Refresh reloads the same installed
inventory; sidebar Search returns from details and focuses that field. Narrow
views use one column. Manage opens the full detail page. Try now returns to the
current conversation only when that plugin is actually enabled there, preserving
the draft and sending no prompt. Uninstall remains disabled with an explanation
until a desktop uninstall API exists. The page shares its mutation and ownership guards with
the composer menu, including the restrictions on live changes. More offers
Open folder and Toggle sidebar. Profile holds **Settings…** and the update entry and
does not claim a signed-in account; a gear above it opens Settings. The update icon appears
for an installable update, or for an offered one when automatic download is off. Scheduled is currently unavailable in the desktop
preview; its disabled control never opens a conversation's background shells.
The sidebar brand (the wordmark with a small green "Beta" badge after it) opens its
workspace menu. The labelled New conversation row is the primary
creation action, rather than duplicating it across icon groups.
The dark icon rail has a slightly deeper surface than the conversation sidebar.
Surface contrast separates the rail from the sidebar without a divider. A
subtle 1px line separates the sidebar's right edge from the main canvas.
The sidebar's corners facing the rail are rounded. When that sidebar closes,
the conversation canvas inherits the same top and bottom corners and clips its
content inside them; the Plugins destination follows the same layout. A smaller sidebar wordmark
sits over an ordered pixel accent that fades across the full sidebar header
width. The accent stays inside that header and does not receive pointer input.
The selected destination uses a filled icon and a neutral rounded background.
Hover, press and selection transitions are brief and respect reduced motion.
Navigation uses rounded stock outline icons and filled selected variants;
composer and result controls use licensed SVG assets. Known provider
routes show their service glyphs; other remote or local routes use cloud or
server symbols with the actual provider label.
Home opens an ordinary blank composer, using the same ownership rules as New
conversation. The sidebar control or
Ctrl/Cmd+B toggles its list. On narrow windows the same control opens a drawer
below the title bar. Compact conversation rows appear underneath their owning
project groups. Group expansion is independent of project navigation, and opening a conversation
reveals its owning group. Folder glyphs follow the actual open/closed state with
a short crossfade and panel transition; reduced motion disables
those transitions. Running work, pending reviews and errors remain visible
in a reserved area on each conversation row.
An ordinary blank project or conversation centres its composer; the first message docks it with a
short transition. Its inset upper strip shows the project and local computer, and only
while the conversation is empty (it fades and collapses over 150ms after the first send, and
never appears while a saved conversation loads); the execution engine is chosen in the model
popup instead. The project menu switches among ordinary project
contexts or opens the native folder chooser; it never adopts a Pal's managed
workspace. The message box remains expanded. The lower row places attachment,
plugin and settings access beside the permission control on the left, with the
selected model and Send or Stop on the right. Only the selected model trigger
reads as text, with no provider glyph: the model name in normal weight, then the
effort in muted text (Low, Medium, Extra High, Max). Its accessible name carries both
("Model: GPT-5.6 Sol, effort: Extra High"); a composer narrower than 420px hides the
effort word and keeps the name. Model rows stay textual.
Send shows a busy indicator while the prompt is being admitted. Model popups
retain their mounted control while focus moves into the menu. The first-message
transition moves the composer from the centre to the bottom and respects reduced
motion; merely focusing the editor does not change its layout. Pal conversations use
the compact, always-docked composer described above; its plus popup keeps model,
permission, attachment and plugin controls accessible. The model control opens the
effort panel when the model offers a choice of effort, and the model list otherwise. This holds for
the second external engine too: its catalogue rows carry the levels the engine reports, and picking
a new level restarts the engine between turns (see [Native engines](native-engines.md)).
The effort panel's header is left-aligned: the effort in the accent colour above the model
link, and a compact engine chip on the right (the engine mark and a chevron, named "Engine:
<label>"). There is no reset icon: double-clicking the slider returns to the model's default
effort, the default stop is drawn as a larger dot, and the slider's value text says "(default)"
there. The engine chip, also in the model list's heading, opens a third view of the same
popup ("Choose an engine", Back returns to Effort or Models). Its rows show the engine mark,
a check on the current one, "Not installed" for an unavailable engine and, on a started
conversation, "Opens in a new tab" for every other engine. When the engine is not Namzu, the
model trigger shows its small icon before the model name.

The model list is compact: 30px rows, 11px group headings, and a height of at most 60% of the window, scrolling inside. Its heading carries the engine chip and, on a long list, a search button (or the `/` key); there is no refresh button, no Retry button and no "Use a model ID" row. Opening the list re-reads a catalogue that failed or has gone stale (older than two minutes) once in the background, showing the last good list meanwhile; if that read fails the list shows one muted line, "Couldn't load the model list. It will try again next time you open this." The list ends with the models; it has no "Current model" section for a model outside the visible list. The provider column marks the provider in use with a small dot, whichever provider's tab is open. GPT names written "GPT-5.6-Sol" by an API provider's catalogue read "GPT-5.6 Sol", as Codex rows do; ids are unchanged. A Zen list shows its free models under a "Free" heading and the models with a stated non-zero price under an "API key" heading (a model with no published price follows under "Other models"); each catalogue row carries an optional `group: 'free' | 'key'`, set for Zen only and stored with the row in `model-lists.json` (an older stored row without it still reads). The headings use the 11px group-heading style, are not rows (arrow keys skip them), are read out as part of each row's name, and appear only when the list holds both groups: a list with only free models shows none, and one with only key models keeps the per-row "(API key)" note. Search keeps a heading only while a row under it still matches.

Starting an engine is cheap to the person and cheap to the machine. Choosing Codex or the second external engine in the engine view never waits for the engine to answer: the host starts reading its models in the background and the choice is acknowledged at once. While an engine process is actually being waited for (a build never read before, so no stored list can be shown) the model trigger reads **Starting Codex…** (or the second engine's name in the same form), with the seconds waited (`Starting Codex… 3s`) once it takes a second, instead of a blank or the previous model; it is announced as "Model, Starting Codex". A stored list shows at once and is revalidated in the background, so nothing is shown while it is. Behind that the CLI host spawns the engine's executable once per use: the Codex app-server that listed the models stays running (closed after two idle minutes, and when the connection closes) and the conversation's first message takes it over, so opening the picker, choosing the engine and sending a message start one process, not two or three. A model list read less than ten minutes ago is served from memory; an older one, or one read in the previous run, is read again in the background, and the last good list of each installed build is kept in `engine-models.json` in the CLI home so a later launch names the default model without waiting. A model the person chose that an older list lacks is looked for once more in a list read now before it is refused.

Model lists persist across launches. Main keeps the last good list per provider in `model-lists.json` in the app's data folder (at most 64 lists and 1 MiB, written to a temporary file and renamed; a corrupt, oversize or foreign file is ignored and rewritten by the next success). The key is the engine, the provider id and a short hash of the provider's id and label as `providers/status` reports them, plus, for an external engine, the `identity` the status row carries (a short hash of the installed executable's path, size and modification time), so an upgraded engine finds no list under its new build and the old one is pruned at once; the status exposes no account or credential field, and the selected-model echo and conversation ids are not part of the key, so every conversation of a provider shares one list. Because the status carries no credential, a sign-out or account change is seen only when a provider row leaves the status or changes: main then deletes that engine's lists for the missing keys, so the next sign-in reads fresh rows instead of the earlier account's. A source that fails is retried at most once a minute, not on every open. A stored list answers `models()` at once with its `fetchedAt`. Main then asks the CLI once per key in the background (never twice at the same time) when the key has not been read in this app run, when the list is older than 6 hours, or when the CLI refused a model choice (the list that offered it is marked stale). A refresh that returns different rows replaces the list and sends one `model-catalogue-updated` event (engine and provider); the renderer then re-reads the matching scopes while the old rows stay on screen, so "Loading models…" shows only for a provider's first-ever read. A failed or empty listing is never stored: the old rows stay and one diagnostics line is recorded. Pal projects and the Pal composer's `palModels` are always read live. A model id not in the previous stored list is stamped with `firstSeen` and wears a small muted "New" chip in the picker for 7 days; nothing is marked on a key's first stored list. A warm launch shows rows in about 0 ms instead of the source's 0.6 s (Codex) to 1.4 s (the second external engine).

The filled effort track is a WebGL2 ordered-dither surface in the accent ramp (deep green to teal to accent to mint) with drifting shimmer, rising sparkles and a thumb bloom that all grow with the level; without WebGL2, or after a lost context it is the plain CSS fill, and under reduced motion it draws one static frame.

Pasting keeps text: when the clipboard carries text, the text is inserted and any
accompanying image rendering is ignored. Files alone are attached when attaching is
allowed; otherwise the composer says "Files can't be attached here." or, for an
engine without attachment support, "This engine doesn't take attachments yet."
Attached files stay removable on such an engine, but Send is disabled with "Remove
attachments to send with this engine." Removing a chip moves focus to the next chip,
else the previous one, else the editor, and a button-initiated Send returns focus to
the editor. An attachment-only draft counts as a draft: Edit on a queued message
waits until it is sent or removed. The "delivered" strip for live input disappears
once the turn settles (pending and unconfirmed receipts stay), and queued messages
left behind by a stopped or failed turn are labelled "paused" because they only start
after the next message finishes.
The right side of an ordinary conversation's header holds two icon buttons:
Conversation actions ("…") and Conversation details. Returning to a blank project
also closes the conversation detail pane. Pal conversations keep their own header.
The actions menu offers Rename… (Ctrl+Alt+R), Pin or Unpin (Ctrl+Alt+P), New side
chat (Ctrl+Alt+S), Fork, Copy, Move to right pane, Move to new window and Archive…
(Ctrl+Shift+A), with Cmd and Option on a Mac. One component draws it for the header
and for each tab's "…" menu, so the two cannot drift; the tab menu adds Split down.
Items show only what the conversation's engine supports: Rename, New side chat, Fork
and Copy as Markdown are for Namzu-engine conversations, Pin and the rest work for
Codex and the second external engine too, and a Pal tab offers only its move items. An item that
cannot run is shown dimmed with the reason as its tooltip (a running reply blocks
Fork and Archive, queued messages, a pending approval and background work block
Archive, and a pane holding one conversation cannot move it right). Shortcuts match
the physical key and are ignored for AltGr (which many layouts, Turkish Q among them,
report as Ctrl+Alt), during IME composition and while a dialog is open.
Rename opens a dialog prefilled with the title; Enter saves, and an empty name
restores the automatic title. Pinned conversations lead their project list and
Recents with a small pin glyph after the title, and in the conversation's tab. Rename, Pin, Fork and Copy as Markdown also work on a sidebar row that has no open tab, because the app adopts the conversation first; only a tab held by another window refuses them. A chord with nothing to do (a Pal conversation, an action the engine lacks) is left to the system; a chord whose action is blocked announces the reason. Fork copies the history into a new conversation in
the same project and opens it as a tab in this pane; New side chat does the same
and then splits it to the right. Copy offers the last reply, the conversation as
Markdown (refused with a message above 4 MiB), the conversation ID and the project
path, and confirms with a short "copied" toast. Archive keeps the confirmation
"Archive this conversation?" with Cancel and Archive.
Every transient message in the window is a toast (Base UI Toast, no extra package),
sent with `notify(text, { action?, tone?, timeoutMs? })` from `renderer/notify.ts`,
which any code path can call. The tone is `neutral`, `success`, `warning` or `error`;
an error is announced assertively and the others politely. A toast lasts 4 seconds, 6
for a warning, 8 with an action or for an error, and `timeoutMs: 0` keeps it until it is
dismissed. Up to three show at once as a stack, the newest in front, and hovering or
focusing the stack fans it open and pauses the timers; reduced motion removes the
animation. Each pane has its own stack, centred in its conversation lane just above the
composer (the lane's `--composer-height`), so the side panel stays clear; `notify` goes
to the pane focused last. Pin and Unpin offer Undo, Archive offers Undo when the host
can restore the conversation, and an undone reply offers Show, which opens the Changes
tab.
Conversation details is a 320px popover. It shows the project name with a "…"
menu holding Copy path (absent for a conversation without a project), Changes with
`+added −removed` line totals for this conversation's completed file edits (a path
counts once, from its first before to its last after; "No file changes yet" when
empty; click opens the Changes pane), the repository row (branch and last commit
subject, read when the popover opens, hidden when the project is not a repository),
Background work with "N running", "Needs attention" or "None" (click opens the
Activity pane), and Sources, the files and images sent in the conversation, newest
first, three shown with View all and a "+" that opens the attach flow. The icon
carries a dot while background work runs and a warning-coloured dot when it needs
attention, with the count in its accessible name. Pending or failed shell reads
remain unconfirmed rather than showing a stale count from another conversation.
Opening a detail pane returns the transcript to the available width. Unsupported
artifact and child-session inventories are absent. No floating card sits beside the
conversation at any width.
A project or Recents row shows two icon buttons on its right while the pointer is over it or the keyboard
focus is on it: Pin (Unpin when pinned) and Archive. They take the place of the relative time in the same
frame, with no fade, so the time and the buttons are never shown together and the row does not shift; the
title fades under them instead of moving. Archive acts at once when the host can restore a conversation and
offers Undo in the toast; without a restore path it keeps the confirmation dialog. The full conversation menu
(rename, pin, fork, copy, open in, move, archive) opens on right-click or with the context-menu key or
Shift+F10 on a focused row. After the pointer rests on a row for 450 ms a card opens to the right of the
sidebar with the full title, the relative time, the computer it runs on, the project folder and, when the
project exposes one, the git branch. The branch comes from the cached project repository read, never a
guess, and the line is left out when it is unknown or the head is detached. The card closes when the pointer
leaves, on scroll, on click or drag, and while a menu is open; it does not open for keyboard focus or touch.
The sidebar uses one folder glyph per project and plain indented conversation
titles. Each group initially shows five conversations, keeping the active one
visible when it lies beyond that limit. Show more reveals additional loaded
rows. Project headings omit connection dots; connection failures and recovery
remain in the existing project status surfaces. Active and running conversations
remain visible beyond that initial limit. Only the accepted navigation's
originating list highlights the active conversation; selecting Recents does not
also select its project copy or folder.
Folder headings are selected only on a blank project route. Activity indicators
remain shared by both copies. Recents repeats the loaded conversation records
across known projects, deduplicated by session ID and sorted by their saved update
timestamps. It shows the ten most recent records plus any active or running
conversation outside that limit. A recent row opens the same conversation as its project row and reads the
same session state; it does not create another session. Recency reflects loaded
index metadata rather than an inferred visit history or live-event timestamp.
Equal timestamps use the immutable session ID as a final ordering key in Recents
and command search. Opening a conversation or refreshing a project index does
not reshuffle tied records; a newer saved update timestamp can change the order.
Idle timestamps appear on hover or keyboard focus. Running turns show a small
neutral spinner at the right of both rows; stopping the turn clears both
indicators even while another conversation is open. Approval requests retain
their approval icon priority. Pending tools, queued messages and background
shells alone do not imply a running turn. The state area keeps a fixed width to
avoid moving the truncated title; reduced motion leaves the running indicator
visible without rotation. Errors remain visible.
Search sits at the right of the sidebar brand header. Clicking it or pressing
Ctrl/Cmd+K opens the same centred command
palette. It searches conversation titles and project names, and includes New
conversation and Open folder actions. Arrow keys navigate while the search
field retains focus; Enter activates the selected action. Escape and an outside
click dismiss the palette and restore focus without cancelling a running turn.
The palette reads conversation indexes from connected, trusted projects when
opened. A failed or unavailable index produces an explicit partial-results
notice and Retry. Search does not start model work or resume sessions by itself.
Conversation history is also loaded when its project is opened; an unopened
group's lack of rows does not imply that the project has no saved conversations.
Other project groups default to collapsed. Opening a project or a conversation
from its project list expands that group; opening Search or refreshing its
catalogue preserves the operator's expansion choices. Selecting Recents does
not expand the owning project group.
The model control is one menu inside the composer; the
provider and exact model choice are edited there before the next message.

Assistant replies render headings, lists, fenced code and tables. User messages
stay literal. Raw HTML cannot execute and remote images do not load. A user click
opens validated HTTP(S) assistant links, including a sole safe inline-code URL,
through the main process's system-browser bridge; other schemes remain inert.
Hovering such a link for half a second, or focusing it from the keyboard, opens
a link card: site icon and name, page title, short description, the page's share
image and the destination address. Nothing is requested before that. The main
process then reads the page head from its own in-memory session, without cookies
or credentials, only for `https:` links on the default port whose host resolves
exclusively to public addresses (private, loopback, link-local, carrier-grade NAT,
documentation and other special-purpose ranges are refused, at every redirect
too). It reads at most 512 KiB up to `</head>`, with four redirects and an
8 second deadline; the renderer parses that head in an inert document. Pictures
are fetched the same way, capped at 2 MiB (256 KiB for icons) and shown only when
their bytes are PNG, JPEG, GIF, WebP, AVIF or, for icons, ICO; vector images are
never loaded. Every refusal or failure leaves a card with the address alone and
no error text, and no address or page text reaches diagnostics. Results are kept
in memory for 15 minutes (2 minutes for a page or picture that gave nothing,
including one a host answered with HTTP 429 "too many requests"; a share image
generated on demand, such as GitHub's, can be rate-limited while its icon still
loads, and the card then shows without the picture until the failure expires).
Under reduced motion the card appears without movement.
Tool output remains a separate tool view. Settled answers have a compact
**Copy reply** action alongside optional read-aloud; commentary, reasoning and
tool details do not receive the answer toolbar. In ordinary and Pal chat, the
known message clock and reply controls share one reserved footer row. They fade
in together on message hover or keyboard focus without changing the row's size
or the reader position; touch layouts keep the controls visible. Playback and
pending, successful or failed copy feedback remain visible until settled.
Copying uses the original reply
text, and reports success only after the native write completes. Code blocks
show their language and a separate **Copy code** control; their parsed code
payload excludes Markdown fences and the renderer's synthetic trailing newline.
Copy failure stays retryable without widening the control. The authenticated
bridge writes bounded plain text only and never reads the system clipboard.
Wide tables scroll within a focusable message region, including keyboard
horizontal scrolling, instead of being clipped by the transcript's outer frame.
Messages and tool rows retain their admitted event order. Repeated provider call
IDs in later turns have separate receipts; progress updates do not move a row.
Interface and composer text use the platform sans stack; code uses the platform
monospace stack. The interface root is 16px, conversation/composer text is 14px
and fenced code/diff text is 13px. The application uses the platform's font face,
so the same stack can resolve to different faces on different operating systems.
The project and conversation breadcrumb uses 14px medium labels with native
text-box trimming where supported; narrow windows retain the conversation title.
Completed file actions expose their bounded before/after previews in Changes.
Open diff opens the same previews (per reply, see [Reply summary, attachments and dates](#reply-summary-attachments-and-dates)); unified/split display and line wrapping work
without reading additional files. Line numbers refer to the preview, which may
contain only the changed fragment. These result views survive a window reload
while the connection lives; the current restart history projection contains text
messages rather than old tool previews. Tool-only assistant records with no text
do not create a media placeholder in ordinary history; text accompanying tools
and actual media placeholders remain visible. This is a display filter, not a
change to the model's recorded history. Syntax highlighting uses bundled WASM;
the renderer policy allows that compilation without enabling JavaScript eval.
Background work uses a separate column when the workspace has at least 880px
available; narrower workspaces use an overlay without squeezing the
conversation. The panel and conversation widths animate together, and the
details control remains mounted during the transition. Closing the panel or
pressing Escape returns focus to the Conversation details button; automatic
navigation does not move focus back to an old panel. Reduced motion disables
these transitions. The composer and navigation remain inside the available width.

## Conversation panes and windows

Drag an ordinary conversation tab to another group's centre to join its tabs,
or before/after a tab to change their order. Dropping near the left, right,
top or bottom edge creates a split when there is enough room for two readable
panes. A tinted preview shows the admitted destination. Dragging a tab outside
the native window opens that conversation in a separate registered Namzu window.
The tab's actions menu also offers Split right, Split down and Move to new window
for keyboard use; split actions appear when the owning group supports them.

Right-clicking the tab strip's + button or its terminal button (or Shift+F10 / the context-menu key on
it) opens a menu: New conversation, New terminal, then New conversation or New
terminal to the right or below, then New window. A left click on + still opens a
new conversation (on the terminal button, a terminal). The new tab joins the current pane, then leaves as the same
split or window move the tab menu uses, so the tab that was in front stays in
front. The terminal entries are shown disabled, with the reason, when the
folder is untrusted, not ready, a Pal workspace, or terminals are unavailable.
Each group selects its own conversation, with its own draft, model, attachments,
queued messages and pending reviews. The sidebar, navigation and application
shortcuts follow the focused group. Namzu tabs use the canonical wordmark's N;
native engines keep their engine marks, and thin separators distinguish tabs.

Splits form a recursive layout rather than a fixed two- or four-panel grid.
Each pane has a minimum width of 380px and height of 300px, with a 4px divider.
The available area determines how many additional splits fit; there is no
four- or eight-pane product limit. Existing splits remain readable after a
window shrinks by retaining the recursive minimum size and allowing workspace
scrolling. Drag a divider to resize its branches, or focus it and use the
appropriate arrow keys; Shift makes a larger step, and Home/End reach the
readable bounds. Keyboard and pointer changes preserve both branches' minimums.
Group controllers keep stable identities when the tree gains or loses a split.

Returning to a fully loaded tab in the same pane reuses its current transcript,
draft, settings and files, together with confirmed provider, engine and model
metadata. Repeated requests to open the same tab share its pending load. This
reuse is valid only while the tab remains in its canonical group and its runtime
connection generation is unchanged. First opens, incoming transfers, cold
restarts, tabs returning after removal, and reconnects load authoritative state
again. An engine change invalidates affected confirmed runtime metadata and
requires an authoritative refresh. Model capability metadata stays keyed to
the exact session, provider and model choice; choosing another model cannot
reuse a different model's capabilities. Reusing display state does not bypass
the current ownership checks.

Opening an already indexed Recent does not relist every project or reread its
project's catalogue. Main retains the last successful catalogue as display
metadata on that exact project connection; strict history validation still
admits every first read. A replaced connection cannot publish its late catalogue.
Unknown restored or transferred IDs still resolve their catalogue against the
current connection. After canonical pane ownership is acknowledged, a cold selection
shows its own loading shell immediately, with no previous transcript and no
session metadata reads before main registers that session. Authoritative history
then displays before provider, draft, message settings, files and readiness finish
loading. Those independent reads run together after main admits the session.
For a first open, strict project/tenant/Pal history validation succeeds before
main registers the conversation. Runtime context loading is deferred to readiness
and shared with provider/engine reads, so full model context restoration does not
delay message display. Failed or obsolete history reads never register an empty
authoritative conversation.
Persisted, previously prompted sessions also restore strictly scoped history
before loading model context, including when the stable UI ID aliases a durable
runtime ID. Concurrent history display and admission share that exact read;
connection, execution and selection changes refuse obsolete results. Unsent
tabs display their owned local projection and saved draft before restoring a
replacement runtime slot and exact engine/model. Provider and engine metadata,
readiness and message admission still await that shared restoration. An unavailable
model leaves the draft visible and actions blocked; opening the display does not
replay a prompt or choose a replacement model.
If the first prompt is refused before the engine starts, main restores that
prompt only when its draft has not been edited or explicitly cleared since
admission. The state event carries the actual restored draft; the renderer
keeps it visible even if the send acknowledgement arrives after the refusal.
Newer typing, clearing and retyping the same text retain their edit ownership.
This recovery does not substitute a model or effort level or replay the prompt.
The [draft recovery browser proof](../../research/runtime-desktop-20260930/artifacts/send-draft-recovery-browser-proof-20261006.json)
checks the real composer and retained sample draft before and after held send
acknowledgements, edits, explicit clears, same-text retyping and navigation.
It simulates the protocol boundary and does not call a model.
The CLI history request opens one fresh session scope for ownership validation,
strict journal reading and Pal public-message projection. All three use that
scope's captured home. Reading one conversation does not construct or synchronize
the installation-wide listing index; indexed catalogue and write operations keep
their existing store. Folder trust and strict project/tenant and Pal claim checks
remain in place, including when a readable row is archived.
Task snapshots, retry-status checks and desktop metadata ownership reads also
use a fresh direct scope instead of opening the listing index. Retry status
uses the host-authenticated scope's captured home for trust, Pal binding and
checkpoint inspection; the actual retry retains its writer admission. ACP
history loading folds one strictly verified, in-scope, nonarchived snapshot
without an index or provider runtime. Existing embeddings that inject an
indexed storage opener retain it until they supply a direct-read opener.
The optional desktop `readyConversation(projectId, sessionId)` acknowledgement
refreshes tasks and retry state in parallel, sharing an in-flight read only for
the exact client, runtime session and execution/selection revisions. The renderer
awaits it alongside metadata before enabling actions; actual sends and retries
keep their own fresh admission. Failed or obsolete readiness cannot make saved
messages writable. Older bridges without this method retain their original
history-plus-readiness opening contract.
Reopening a previously loaded conversation in the same renderer can first show
its saved messages immediately after canonical opening, overlapping its metadata
reads with current history. An “Updating
conversation…” status identifies this read-only display while main's history
read is pending. It is not a current snapshot or permission to send: messages
received while the tab was closed replace the saved display when main returns,
and buffered live events merge by revision. A history failure leaves saved
messages labeled as such and offers Retry setup. Connection changes retire the
saved display's provenance. Incoming transfers and cold renderer restarts have
no such local history and read main first.
The composer, approvals, queued-message edits and retry controls remain disabled
until the complete load succeeds; a metadata failure leaves the history visible
and offers Retry setup. Shell polling, engine discovery and extra visible-task
refreshes start after core admission so their store reads do not compete with
first history and readiness. Until a shell read finishes, its state remains
unknown rather than reporting zero running jobs. A removed tab still refreshes main's live projection,
so the saved display cannot become admitted history in place of the current
snapshot. Initial attachment reads share an in-flight refresh for
the same owner, API and mutation revision rather than superseding its admission.
Pausing automatic reads while that owner changes engines or reloads history does
not retire the explicit snapshot awaited by setup. Leaving the owner, replacing
the API or changing its files still refuses an obsolete response; old API cleanup
cannot cancel the replacement API's read.
Saved message settings also share one explicit refresh for the same owner and
API while setup waits. Eligibility changes leave that refresh admitted; owner
navigation and API replacement retire it before late responses can publish.
Returning to the same conversation gets a new read lifetime, which an old
cleanup cannot cancel. A refresh waits for admitted local saves and retains an
unconfirmed choice after a failed save. Pending and queued saves keep the API
that admitted them rather than moving to a replacement bridge. A late read or
retry error cannot appear on another owner or API.
The [deferred restoration browser proof](../../research/runtime-desktop-20260930/artifacts/pal-reopen-progressive-browser-proof-20261006.json)
holds history and provider responses to verify saved and current history,
blocked actions, independent reads, error recovery, obsolete navigation
rejection and call-free warm tabs.
Its in-memory preview fixtures do not establish durable native history.
The [Recents opening browser proof](../../research/runtime-desktop-20260930/artifacts/recents-progressive-browser-proof-20261006.json)
separately holds cold history and readiness, verifies immediate selection,
disabled pending actions, retained metadata overlap, obsolete navigation,
failure recovery and no catalogue reread for known navigation. No model or
computer action is performed.
The [unsent draft browser proof](../../research/runtime-desktop-20260930/artifacts/recents-progressive-unsent-browser-proof-20261006.json)
holds provider preparation and readiness while verifying immediate saved-draft
display, a blocked composer, the exact nondefault model, and rejection of a draft
response from an obsolete navigation. These are synthetic deferred boundaries,
not native engine-restoration timings.
The [native Windows timing observations](../../research/runtime-desktop-20260930/artifacts/recents-native-performance-20261006.json)
retain the baseline and each deployed build on the same two conversations. The
preceding scoped build selected cold tabs in 40.5 and 36.5ms; warm navigation took about 13ms.
The authoritative-display markers took 1936.3 and 252.7ms, with composer readiness
at 2601.5 and 1738.1ms. The [native stage profile](../../research/runtime-desktop-20260930/artifacts/recents-scope-profile-native-20261006.json)
later identified the first example as an unsent external-engine draft with no
current runtime journal: its marker waited for replacement and model restoration,
not a strict history read. The second example is a durable 6KB conversation;
an isolated deployed history request took 226ms, with Windows ACL subprocesses
accounting for about 154ms of its direct-scope preparation. No permission checks
were cached or disabled. Immediate selection and warm reuse do not establish
instant cold history or a uniform readiness improvement. The latest direct-readiness
build selected the unsent draft in 38.3ms and displayed its empty owned projection
at that same marker, while model readiness still took 2866.1ms. Its durable
conversation selected in 207.1ms, reached the history marker in 1002.5ms and enabled
the composer in 2080.3ms. Warm readiness took 14.3 and 19.2ms. The latest probe's
original strict restoration failed because reactivating the original tab expanded
one previously closed project folder. A separate guarded correction restored that
single disclosure and verified all original protected state; the failed receipt
remains failed. Earlier successful probes and the supplemental corrected state
retain original workspace, drafts, settings and messages. These are two examples
per build, not latency percentiles or proof of uniformly faster cold history.
The [verification receipt](../../research/runtime-desktop-20260930/artifacts/recents-desktop-verification-20261006.json)
records the final source checks, UI fixtures, guarded native activation and
measurement limits. Local activation changed the desktop build and three
reviewed CLI modules, retaining the SDK and remaining runtime dependency graph.
The [native Windows close/reopen proof](../../research/runtime-desktop-20260930/artifacts/pal-reopen-saved-native-safe-20261006.json)
separately observes saved-message display, authoritative refresh and composer
readiness in the existing app. It verifies the refresh label and blocked
pending controls while preserving tabs, histories, drafts, model selections,
preferences and the running Pal computer's generation and operator control.
Recorded durations are observations of that run, not a latency guarantee.

The Pal sidebar uses this same activation path when its latest known conversation
is already an admitted tab in the current pane. It does not fetch the Pal record
and conversation catalogue again for each revisit. After an actual unchanged
catalogue confirmation it can also target that latest conversation after its
tab closes, while retaining canonical ownership checks and full history and
metadata hydration. This target shortcut grants no cache admission. An
unconfirmed catalogue, an ambiguous or unavailable project, or a replaced
runtime connection refreshes the Pal and catalogue first. Removed/moved tabs
and pending model changes still require fresh session admission. This is
navigation reuse; it grants no new message, computer or tool authority.
Authored prompts, streamed conversation updates and retries retire that Pal's
catalogue freshness without changing the displayed recency merely on selection.
Its next sidebar open refreshes the authoritative list once. Activity arriving
during that read cannot certify the returned list as current; other Pals' warm
routes remain unaffected. Pal edits and connection changes also retire catalogue
confirmation.

The [native Windows activation receipt](../../research/runtime-desktop-20260930/artifacts/workspace-tabs-layout-latency-native-safe-20261005.json)
verified that the same canonical tabs survived cold start and retained their
drafts, settings, files and selected model. With normal motion and an actual
WebGL character, the same scene canvas was reused; its idle canvas was detached,
its context retained and its draws stopped. Observed warm click-to-ready samples
were 37–46ms for the ordinary conversation and 44–56ms for Pal chat, compared
with earlier 406–1129ms and 734–1040ms samples respectively. These are local
observations for existing tabs in one pane, not timing assertions or guarantees
for first loads, transfers or reconnects. No messages were sent by this check,
the computer remained offline, and final native service diagnostics reported
no errors.

The [Pal sidebar receipt](../../research/runtime-desktop-20260930/artifacts/pal-navigation-native-windows-safe-20261005.json)
checks real Sıtkı and Kiro sidebar clicks as well as their tabs. Warm Sıtkı sidebar
samples fell from 2431–2509ms to 29–31ms; Kiro samples fell from 436–489ms to
15–18ms. The first Sıtkı open after renderer reload still needed 3475ms for
uncached history and metadata. The renderer update kept the native process,
computer allocation, user profiles, messages, drafts, settings, models and
window placement unchanged. These timings are observations for those existing
conversations, not thresholds enforced by tests. No inference or guest action
was requested, and the current native instance had no diagnostic errors.

One main-process Operator continues to own all runtime connections across these
views. Moving a tab does not start another SDK loop, restart its engine or replay
its prompt. The main-owned layout grants each conversation one writable window.
A cross-window move reserves the tab while the source saves pending editor
changes and the destination loads its history, draft, settings and attachments.
Both windows acknowledge readiness before main commits the new owner. A failed
or cancelled transfer leaves the source placement authoritative. Closing a
detached window returns its tabs to another open Namzu window without cancelling
their admitted work. Closing the final window uses the normal runtime shutdown.

Main persists the versioned window layout, tab identities, active groups,
split ratios and window bounds in `workspace-layout.json` beneath the native
application data directory. Draft text, attachment bytes, provider credentials
and model prompts are not part of that file. A pending native destination is
excluded until its transfer commits. Restored window bounds are clamped to an
available display's work area; missing displays cannot strand a window offscreen.
Reloading a view reopens its actual main-owned conversations without replaying
messages.

Private desktop state is separate from admitted CLI history. Main saves stable
project and conversation identities, their actual runtime IDs, unsent text,
composer choices and confirmed provider selections in `desktop-conversations.json`
under the native application data directory. Draft attachment bytes live in a
referenced `desktop-draft-attachments.<sha256>.json` file. Attachment changes write
the new blob before atomically replacing its metadata reference; typing updates
the small metadata file without repeatedly encoding image bytes. Preview images
are rebuilt from validated bytes instead of being stored twice. New files request
owner-only permissions on POSIX; Windows uses the application's user-data access
controls. Provider credentials, queued prompts, pending approvals and running
activity are not stored here. A second application launch focuses the existing
native instance so one main process owns the profile.

An unchanged metadata snapshot skips another atomic write and filesystem sync
only after an identical snapshot has committed successfully. Failed writes are
retried; this optimization does not acknowledge an unsaved draft or change the
attachment-before-metadata commit order.

A cold restart reopens durable history using its saved runtime ID, including
conversations outside the recent catalogue. An unsubmitted conversation has no
CLI journal yet: the desktop keeps its UI and draft owner, creates a replacement
runtime slot, and restores the exact selected Namzu provider/model or native
CLI engine/model before allowing Send. Saved effort, permissions and files remain
with that owner. Restoration failures retain the draft for retry; they do not
substitute another model. Neither reopening nor restoring a draft sends a prompt.

The geometry, ownership and persistence behavior have deterministic coverage.
Native Windows fixture checks verified four and eight panes, independent drafts,
pointer and keyboard divider resizing, centre joins, edge splits, menu detach and
an actual outside-window tab drag. The drag captured mouse-down, drag-start and
drag-end delivery, then retained the draft, selected model and file across two
native windows. The eight-pane fixture measured at least 463px by 652px per pane,
above the product's readable minimums. A full application restart retained empty
conversation UI IDs, draft settings and files while creating new runtime slots
without prompt replay. See the [eight-pane capture](../../research/runtime-desktop-20260930/artifacts/workspace-eight-panes-native-20261004.png)
and [detached-window capture](../../research/runtime-desktop-20260930/artifacts/workspace-detached-native-20261004.png).

A separate native Windows check selected an actual Codex CLI catalogue model
with its default effort, sent one prompt through the composer, and detached its
tab while the real CLI thread was running. The source tab disappeared and the
new native window received live updates while the same main process retained
the single prompt. A read-only command approval arrived after the transfer;
allowing it once in the destination led to the expected successful answer with
no reported errors. The [sanitized running-transfer receipt](../../research/runtime-desktop-20260930/artifacts/workspace-running-native-safe-20261004.json)
records these results without runtime IDs or raw history.

The same real CLI conversation then received a second read-only command prompt.
Its approval was already waiting in the source before another cross-window
move. The destination retained the exact pending approval identity; allowing
it once there completed the second command successfully. The conversation
still contained exactly two authored prompts, with no replay or reported
errors. See the [pending-approval transfer receipt](../../research/runtime-desktop-20260930/artifacts/workspace-approval-native-safe-20261004.json)
and the [workspace-only capture of both settled turns](../../research/runtime-desktop-20260930/artifacts/workspace-running-native-safe-20261004.png).
Closing all three extra native windows acknowledged their closes, returned
their owned conversations to the original window, flushed the latest draft
and retained that two-prompt history without errors; the [native-close receipt](../../research/runtime-desktop-20260930/artifacts/workspace-native-close-safe-20261004.json)
records the result. These actual-runtime checks exercised the installed Codex
CLI; they do not claim equivalent native proof for every provider or engine.

A final cold start of the compiled native app, using normal application data
and native window bounds restoration, also reopened that completed Codex
conversation. It retained both authored prompts, the expected second answer,
the latest unsent draft and the exact selected model, with no replay or reported
errors. The [completed-history cold-start receipt](../../research/runtime-desktop-20260930/artifacts/workspace-running-cold-safe-20261004.json)
records this separately from the earlier empty-conversation restoration.

## Transcript activity and timing

### Planning tasks

Namzu conversations retain their existing session planning list in the shared
conversation projection. In Pal conversations, progress appears inside the
existing Pal card. An ordinary conversation draws its plan as one row inside
the "Worked" block of the latest turn that touched it, and no longer draws a
"Tasks" chip after the transcript:

- While the turn runs the row reads "Plan · 2/5 · *the task in progress*" and
  sweeps like a running action. It opens to a checklist (done rows muted, a
  spinner for the task in progress, an empty circle for a pending one, a cross
  for a failed one) of at most six rows, then "+N more", which opens Activity.
  It updates in place by task id, so a task update never adds a row.
- When every task is done it reads "Plan · 5/5 done" in muted text and starts
  folded. A turn that ends with tasks left reads "Plan · 3/5" in normal text.
  An earlier turn that touched the plan shows one muted "Updated tasks" line.
- The task tools (`task_create`, `task_update`, `task_list`, `task_get` and an
  engine's `TodoWrite` or `update_plan`) fold into this row. They never draw as
  action rows and are not counted in "Used N tools". The row is built from the
  conversation's task list plus the turn's task tool calls, so a reload matches
  the live view. Updating a task replaces it at its place in the list.
Subjects, reported statuses and dependency subjects are shown without raw IDs.
Planning state is agent-maintained: a completed item does not independently
verify an artifact. Failed items remain distinct from completed items. The
project-context entry for background terminal jobs is labelled Shells.

Pal cards summarize the reported plan as **Progress**, counting only completed
steps rather than estimating an execution percentage. Finished plans start
folded; active, pending and failed rows start disclosed, with state icons and
dependency subjects. A failed dependency is terminal rather than an unresolved
wait, and its failed outcome stays visible. The ordinary Activity task list
retains its existing presentation.

The [composer-summary removal preview](../../research/runtime-desktop-20260930/artifacts/pal-progress-no-composer-browser-20261006.json)
verifies a single Pal progress region in the card, no transcript summary for
completed, mixed, failed or unavailable plans, keyboard disclosure and wide/short
layouts. Synthetic ordinary tasks still open Activity from their summary. This
preview uses in-memory fixtures without model or computer actions.
The [native Windows receipt](../../research/runtime-desktop-20260930/artifacts/pal-progress-no-composer-native-20261006.json)
verifies the renderer-only update: the extra summary changes from one to zero,
the card retains its three real completed steps and disclosure, and messages,
drafts, model choices, tasks, computer generation/control and native processes
remain unchanged. This update does not activate the separately staged SDK/CLI fixes.

**Recent activity** uses plain intent labels and actual execution states.
For example, `send_pal_message` appears as **Message to another Pal · Sent to
inbox**, and `list_pals` as **Available Pals · Checked**. Inbox acceptance does
not claim the recipient read or answered. Unknown tool names use a neutral
action label; arguments, commands, paths and receipt bodies are not mined for
card titles. Successful planning bookkeeping stays in the plan and retained
tool timeline, while failed planning actions remain visible on the card.
Recent activity does not open a technical pane. Output details expand inside
the existing card without adding a Changes column.

**Messaging a Pal from an ordinary conversation.** When a normal Namzu-engine
conversation calls `send_pal_message`, the approval card is titled **Message to
*Pal name*** (the name is looked up in the Pal list; an unknown ID reads "Message
to a Pal"), shows the whole message in a scrollable block (never cut, so nothing is
approved unseen), and says it goes to the Pal's inbox, does not start the
Pal and is asked again for each message. It offers the usual Reject, Edit and Accept
only: there is no "allow for this conversation" choice. The action row reads
**Messaging *name*** while it runs and **Messaged *name*** once accepted, with the
hover text **Sent to inbox**; a failure reads "Couldn't message *name*" and a No
reads "Declined message to *name*". The name comes from the tool's own call and
receipt labels, which a reload keeps, so a reloaded conversation keeps the wording.
A Pal's own `send_pal_message` row, which names no Pal, is unchanged. The Pal's
communication dialog lists an owner message as **Message from your conversation**,
without its body.

The [earlier progress preview receipt](../../research/runtime-desktop-20260930/artifacts/pal-progress-browser-proof-20261006.json)
checks completed disclosure, active/failed/dependent steps, unavailable reads,
safe action labels, exact disclosed receipts, error colors and narrow/short
layouts with synthetic fixtures. The
[native Windows receipt](../../research/runtime-desktop-20260930/artifacts/pal-progress-native-safe-20261006.json)
records the actual renderer deployment and a follow-up inspection without
another reload or model turn. Messages, models, drafts, tasks and computer
generations/control retain their observed state. The initial deployment check
rejected encoded presentation-preference string equality after verifying the
UI; the follow-up verifies parsed preferences against the deployed baseline.
The [earlier native folded card](../../research/runtime-desktop-20260930/artifacts/pal-progress-completed-collapsed-native-20261006.png)
and [disclosed steps](../../research/runtime-desktop-20260930/artifacts/pal-progress-completed-disclosed-native-20261006.png)
record the actual Sıtkı plan before the compact row treatment. The
[compact preview receipt](../../research/runtime-desktop-20260930/artifacts/pal-progress-compact-browser-proof-20261006.json)
checks right-aligned status badges, the count capsule, long titles and dependency
context at 240–300px card widths using isolated fixtures. The
[compact native Windows receipt](../../research/runtime-desktop-20260930/artifacts/pal-progress-compact-native-safe-20261006.json)
records the actual completed rows shrinking from 55.5px to 32px, preserving
planning records, conversations, drafts, models, presentation and computer
control during a renderer-only update. The
[earlier compact native steps](../../research/runtime-desktop-20260930/artifacts/pal-progress-compact-disclosed-native-20261006.png)
show the former full-count capsule and Done badges.

The [current card preview receipt](../../research/runtime-desktop-20260930/artifacts/pal-progress-card-only-browser-proof-20261006.json)
checks number-only keycaps, static action summaries, completed diff output
disclosure inside the card, absent Pal technical panes and ordinary conversation
panels. The preview store resets on reload; recreating its synthetic Pal with an
old open-pane preference verifies normalization, not durable history persistence.
The [native Windows receipt](../../research/runtime-desktop-20260930/artifacts/pal-progress-card-only-native-safe-20261006.json)
verifies an actual renderer reload, migration of the existing Pal's open pane,
numeric keycaps and the absence of a technical column while preserving messages,
drafts, models, tasks and computer control. The
[current native card](../../research/runtime-desktop-20260930/artifacts/pal-progress-card-only-disclosed-native-20261006.png)
shows the compact rows and two numerical capsules.

The [native Windows task receipt](../../research/runtime-desktop-20260930/artifacts/task-tracking-desktop-native-windows-safe-20261005.json)
records two actual Pal composer sends using the existing free model, guest file
reads, streamed task changes, a deliberately failed input, dependency removal
and three completed rows retained after normal process restart. It verifies
the durable desktop snapshot rather than accepting the provider's prose as
storage evidence. The model-facing `task_list` is a narrower current-turn view.

The desktop opts into `namzu/tasks` notifications and reads `namzu/tasks/list`
when opening durable history, replacing a runtime connection and reconciling
a settled turn. Opening ordinary Activity or showing the Pal card performs a read-only
idle refresh, including
background changes that occurred after the query's event subscription ended;
it starts no model request. No new polling or per-tab read is added. Reads
authorize and read through the same exact project, tenant and Pal scope where
applicable. A snapshot arriving after a newer live mutation or connection
replacement cannot overwrite that mutation. Deleted tasks are removed, and
updates replace the row so cleared owners and dependency lists do not linger.
Descriptions, task metadata, tenant IDs and storage paths are excluded from
these projections.

A corrupt or unreadable task list retains previously known rows and shows an
unavailable notice rather than clearing them as if the tasks were deleted.

Older CLI connections keep their existing behavior without this optional
extension. External harness transcripts are not silently interpreted as Namzu
planning tasks. See [task tracking](../sdk/task-tracking.md) for the existing
planning, delegated-invocation and resident-pursuit contracts.

### Reply summary, attachments and dates

Each reply that completed file edits carries its own card right under its final
reply: one file reads "Edited name.css +12 −3" (full path in the tooltip), several
read "Edited 3 files" with the totals and expand to a list with each file's own
totals. Totals count a file once, from its first before to its last after; a file
whose edits cancel out is left out, and a reply with nothing left has no card. The
card appears when the turn settles, groups by the turn each receipt belongs to, and
works the same for history restored from the journal. View changes (or a file row)
opens the Changes pane on the Last reply scope for that reply; the conversation
header's Changes button and the Changes tab open on This conversation. Pal
conversations keep their own outputs. The card also carries
[Undo](#undoing-a-reply).

### Undoing a reply

Beside View changes the card offers Undo when the connected CLI advertises
`namzu/turns/undo-status`, `namzu/turns/undo-preview` and `namzu/turns/undo` (an older CLI
shows no button) and the reply has a journal turn id. What the card shows is only ever the
CLI's `undo-status`, read after a conversation's history loads and after every settled reply
and every undo; it is never kept in component state, so a reopened conversation shows the same
card. Five states: hidden (still streaming, no turn id, nothing covered), enabled, disabled with
the reason ("Wait for the current reply", "Undo expired"), undone (a muted chip, "Undone at 10:42"
when this window saw it happen and plain "Undone" after a reopen, with the line totals dimmed) and
partial ("Partly undone, 2 files kept", the count read from a fresh plan, which opens the plan again
to finish the rest).

Undo opens a confirmation dialog built from `namzu/turns/undo-preview`. Each file is a row:
Restore, Delete (the reply created it) or Conflict with its reason (changed since this reply, a
later reply changed it too, the saved copy is gone, now a link, now outside the project). A
conflict is skipped; only a changed-since file offers "Restore anyway, keep my copy", which saves
the current file before the reply's version goes back. "Also undo later replies" appears when a
later reply changed the same files and reloads the plan with those replies' rows under their own
heading. Files the history cannot cover are listed under "Not covered" with the reason. A reply that
ran shell commands says "This reply also ran shell commands. Undo cannot reverse what they changed."
and queued messages are named, since they will run after the undo against the restored files. The
primary button states the count ("Undo 3 files") and is disabled when nothing would change. Focus
starts on Cancel, Esc cancels, and nothing is written until the button is pressed. If the files or
the history moved since the preview, the CLI answers `plan-changed` and the dialog shows the new plan
in place with a notice; it never applies a plan the person did not see. After an undo the dialog
lists what happened to each file, the open file and the Changes view read the disk again, and the card
updates from a new status read.

In the main process `undoTurn` mirrors a retry's admission: it refuses while the conversation is
running, being admitted or changing plugins, takes the prompt-admission slot so no message starts
under the writes, validates its arguments and the CLI's answer, and releases the slot in `finally`.
`undoPreview` and `undoStatus` only read. The renderer API is optional (`undoStatus`, `undoPreview`,
`undoTurn`) and is fenced to the owning pane like the other session actions.

### Changes review view

The Changes tab shows one file's diff beside the tree of changed files. A scope menu
at the top left picks what is reviewed, with the line totals of that scope beside it:
Last reply (the reply the card opened, or the latest one that changed files), This
conversation (every completed edit merged per path, so a file edited twice is one
row, from its first before to its last after; an edit receipt carries only the
changed fragment, a `write` receipt the whole file) and, in a trusted ordinary project
that is a git repository, Uncommitted changes (the working tree against HEAD, whole
files, read through [`projectChanges` and `projectDiff`](#working-tree-changes) when
the scope opens, on the refresh button and when a turn settles). The toolbar has
split or unified, wrap lines, refresh (uncommitted only), collapse folders and a menu
that copies the changed paths. Empty scopes say so: "No changes in the last reply.",
"This conversation hasn’t changed files yet.", "No uncommitted changes." and "This
project is not a git repository."

At 640 px or wider the panel has two columns, the diff on the left and a 260 px file
tree on the right; narrower, the tree sits above the diff and folds away behind a
"Files" button. The tree compresses chains of single-child folders (`.work/sessions`),
lists folders first, marks Markdown files, shows `+N −M` per file ("new" for an
untracked file, "binary" for a binary one, a struck-through name for a deleted one,
and "old → new" in the tooltip of a renamed one) and has a fuzzy "Filter files…"
box. Arrow keys, Home and End move, Right and Left open and close folders, and Enter
or a click shows the file. `[` and `]`, or Alt+Up and Alt+Down, step to the previous
and next file. The diff header shows the path truncated from the left (the full path
in a tooltip), its `+N −M`, Open file (a file tab), Open in editor and a menu with
Copy path and Copy diff. A binary or oversized file shows a plain message instead of
a diff.

A diff past 180,000 characters (both sides together) or 1,200 changed lines (added plus removed)
is not drawn in the rich view, which would freeze the pane on a very large file. The pane
shows the plain unified patch in a monospaced block instead, under a sentence that names the
reason and a "Show full diff anyway" button. The button turns the rich view on for that file until another
file is chosen. The limits and the decision are in `changes-review/diff-gate.ts`. Diffs and file source are
drawn by `@pierre/diffs` 1.5.2 (exact); the worker pool is not used because a worker needs
`worker-src` in the renderer's content security policy, which has none.

A finished turn reads "Worked for 4m 17s" when its duration is known: the host's
start and end, the journal's recorded duration, or the host start and the last time
seen in the turn, in that order. Otherwise it reads "Worked" with no figure.

A sent message shows its image attachments as a right-aligned stack of thumbnail
cards (200px square, cropped to fill) above the bubble, and text files as compact
cards. While a message is still being delivered an image whose preview has not
arrived shows a spinner in a box of the same size, so nothing moves when it lands
(static under reduced motion); after a preview is evicted the card keeps saying
"Preview unavailable". A message with attachments and no text has no bubble.

A centred muted date separator ("Thu 6 Aug, 10:06", in the app locale) precedes
the first message with a known time, any later one on a different calendar day, and
any later one more than six hours after the previous known time. Messages with an
unknown time never produce or move a separator. Pal friend chat has none.

### Live phases

The transcript follows admitted runtime events. While the work runs, the content stays in
order under the **Working for Ns** heading and ONE muted, shimmering status line sits at
the bottom of the block, after the newest entry. It is drawn only when it adds something
the block does not already show, and it changes only when the work enters a new stage,
never on a timer (the same stage derived again on every streamed token changes nothing):

1. A pending approval: Waiting for your decision (always shown; it holds still, with no
   shimmer).
2. The newest entry is a reasoning segment: its headline (a leading bold run, else the
   first sentence; Thinking while it has none yet) becomes the status line, and that
   reasoning row is not drawn while it is the newest entry. As soon as anything newer
   arrives the row draws in place as usual, and a finished turn shows every reasoning row.
3. Nothing is running and nothing new arrived since the last finished action or narration:
   Thinking.
4. Otherwise no line: the newest entry is itself the live element, whether a running
   action row, the plan row with a step in progress (both shimmer in place) or narration
   being written, whose trailing line carries the same soft sweep until the message
   completes.

The text is plain (markdown stripped) and at most 80 characters, cut at a word boundary.
Each new stage fades in and restarts the sweep that shimmers across it; reduced motion swaps
it instantly and shows every shimmer solid. The line is a polite live region that announces
each new status once, never the clock, never streaming narration word by word. It goes when the answer starts or the
turn ends. Before the work block exists the quiet end-of-transcript status stands in. Tool
work and answer streaming retain their own phase in the projection. A provider that withholds reasoning can indicate
an active block without supplying a readable body; the desktop does not expose
opaque reasoning, signatures or replay material. A provider that withholds reasoning can indicate
an active block without supplying a readable body; the desktop does not expose
opaque reasoning, signatures or replay material.

In ordinary conversations, work belongs to its admitted runtime turn. Saved
steering messages with the same recorded turn identity stay in that turn. Its public
reasoning, tool receipts and explicit commentary stay in admission order inside
a collapsible work summary. While live, its outer heading says **Working for**
the host-observed elapsed time when known, or **Working** when no start is known.
The status line described above sits at the bottom of the live block, without a second
elapsed counter. With no public work disclosure, the live status alone can show
the elapsed time. Steering can create another ordered work segment in the same
turn; only the latest public segment owns the turn's time and outcome heading,
and earlier segments say **Earlier work**. Opaque reasoning alone does not
create an empty disclosure. Settled headings retain **Worked for** the observed
or recorded duration, Paused, Stopped or Work incomplete as appropriate. The
summary opens while that turn runs and folds to its **Worked for** line (without animation, so a reader at the end does not bounce) the moment the answer starts or
the turn ends, even if the person watched it; a restored one opens closed, and a choice
the person made wins and is kept. The whole process between the person's message and
the answer (narration, reasoning, every run and single action) is that one block, and
nothing inside it draws a clock: not the narration, thoughts, action rows, run
summaries or the heading. Each row keeps its full time in its tooltip and accessible
description ("Observed by Namzu: ..."). A reply shows one clock, under its answer in the
footer row, or, when it ends without answer text (stopped, failed, only actions), at
the bottom of the turn; none while it is still being written. The answer appears below that group only when it is
a trailing answer; grouping never moves text across a later tool or reasoning event.
Message and text-part identities preserve distinct responses. Providers without
phase metadata retain their admitted order without invented commentary labels.
An authoritative completion replaces its streamed partial text, including an
explicit empty result that withdraws rejected output. A reply the operator
stopped mid-answer is not committed by the runtime, so ordinary cold history
restores its saved text from the journal's cancelled completion as a display-only
row marked `stopReason: 'cancelled'`, placed after the last row of its turn and
timed from the message's recorded start. A stopped reply with no text, one already
committed, or one later replaced adds no row, and Pal history is unchanged.

Public commentary and admitted readable reasoning appear as ordinary foreground
text inside work details, without visible internal phase labels. Their admitted
phase, accessible descriptions and known times remain available; the final
answer stays outside that disclosure. Whitespace-only entries do not hide a
substantive trailing answer.
Restored commentary keeps its phase only when unchanged selected journal text
proves it. A cold history with no completion metadata says **Work details**,
without inventing a successful outcome or elapsed duration.

Action rows distinguish Running, Waiting for approval, Completed, Failed,
Cancelled, Interrupted and recorded Skipped actions using the exact call's admitted state. An approval
for one call does not relabel its siblings. Cancelled confirmations are neutral;
failed command output remains inspectable. Command and file labels require
actual command/path metadata rather than a terminal-shaped result alone.
Mixed groups retain waiting and unsuccessful states in their heading.
The initial action caption survives a successful hidden receipt; redundant
single-line result text does not create an empty or duplicate disclosure.
Distinct output, diffs and progress retain their actual content. Empty pending
output says **No output yet**, while settled rows describe the actual outcome.

An interrupted assistant lifecycle is not a delivered Pal reply. Live Pal chat
and cold history exclude explicitly cancelled partial messages, retaining
genuinely completed earlier replies and the durable journal. The
[content browser proof](../../research/runtime-desktop-20260930/artifacts/transcript-content-browser-proof-20261007.json)
checks real renderer disclosures, content boundaries, keyboard access, themes,
narrow layout and Pal delivery with isolated events and no model requests.

The [native preservation audit](../../research/runtime-desktop-20260930/artifacts/transcript-content-native-preservation-20261007.json)
checks the Windows update's 634 renderer files and three changed CLI modules;
the installed SDK remains unchanged. The original exact-state activation receipt
remains failed because four restored assistant messages gained source-backed
commentary/final phases. The separate audit proves those four additions from
strict, ordered journal projection and preserves all 22 displayed message bodies,
drafts, model choices and other protected state. Journal hashes are observed
after activation; this does not establish a before/after journal byte comparison.
A separate native process/window observation confirms the updated window remained
open after the read-only browser connection closed. This update makes no model
or computer request. The [verification summary](../../research/runtime-desktop-20260930/artifacts/transcript-content-verification-20261007.json)
records workspace checks, affected builds and the renderer tests; it does not
claim the remaining release gates passed.

New admitted transcript entries fade from 65% opacity over 120ms without moving
the text. A phase change retains one readable label and a 120ms opacity effect;
there is no outgoing label or moving text gradient. A small status dot indicates
ongoing work and stays still while a review waits. Status presence and work
disclosures change height over 260ms; the work panel also fades through the same
symmetric easing. Known clocks and durations reserve their row space before
hover; hover changes only opacity over 160ms, leaving message, action, chevron
and reader positions fixed. Missing clocks reserve no space. Keyboard focus
reveals a visible outline immediately. The height effect completes independently
of the shorter text effect. Streaming chunks do not restart an entry effect,
and mounted history, navigation and pending restoration do not replay it.
Interrupted changes retain the observed opacity and height without dimming the
new phase below 65%. Reduced motion settles the current state immediately. Pal
conversations retain their delivered chat bubbles and their own concise
Typing/Working states. The
[single live status browser proof](../../research/runtime-desktop-20260930/artifacts/transcript-single-live-status-motion-proof-20261006.json)
records the earlier expanded, collapsed and private-reasoning behavior. The
[supplemental calm-motion proof](../../research/runtime-desktop-20260930/artifacts/calm-transcript-motion-browser-proof-20261006.json)
records the preceding motion behavior. The [motion research overview](../../research/transcript-motion-20261007/README.md)
distinguishes those historical dimensional-hover measurements from the current
design. These proofs use isolated events rather than native/model actions. The
[current fixed-slot hover proof](../../research/transcript-motion-20261007/HOVER_PROOF.md)
checks constant parent, neighbour and scroll geometry through hover, reversal
and focus in four viewport and motion settings, with the [source-bound receipt](../../research/transcript-motion-20261007/artifacts/hover-fixed-layout-564aaf64-ce37969e.json).

### Action rows

The work list sits flush with its heading (no indent, no left rail); finished rows are a step
lighter than the running row and the run's summary line. Each action is one muted line (24 px, 14 px text, a 14 px icon);
the live heading is one phrase ("Working for 7s", no chevron until hover or
focus) and the current action shimmers (static under reduced motion, and still
while it waits for approval). Only the action that is running shimmers, not the finished
rows inside the same run.

| Action | Row | On hover or focus | On click |
| --- | --- | --- | --- |
| Command | Running command, Ran command, Command failed | the command, one line, 200 characters at most | opens the command and its output |
| Edit | Editing, Edited, Created or Deleted *name*; Waiting to edit; Couldn't edit | the full path | the Changes panel on that file for that reply |
| Read | Reading, Read *name* | the full path | the file in a tab |
| Search | Searched for *pattern*, Listed files in *folder* (60 characters, whole text in the tooltip) | the whole text | opens the results when there are any |

Created and Deleted come from the receipt: an empty before is a creation, an empty
after a deletion. The file name is the last path segment with a dotted underline; a
relative path is shown in full against the conversation's folder, with `.` and `..`
resolved. Screen readers get the command or the path as the row's description. An edit never expands
in the transcript; its Before and After live in the Changes panel. When the reply has
no completed receipt for the path yet (or the path was never receipted) the click opens
the file instead. Status and time show on hover; a failure always shows. A row never draws a
clock: a call that took a second or more says "Took 6 s" in its hover text and to screen readers,
and a faster one says nothing.

A reopened conversation names each action the way the live row did. The kernel journals one label
line (200 characters at most) for every call that has no diff, or a command's first line, never the
output, so "Added task · Map the repo", "Ran agent explore" and "Ran command" read the same after a
reload; an engine's own tools are named by a small map (shell, read, edit, write, search, agent,
task list) and anything else reads "Used" plus its name in words. A call whose view was never saved
(an older conversation) reads "Used" plus its name, is not expandable, and says "Details were not
saved" in its hover text. A command that printed nothing has nothing to open. Opening a small panel
while the transcript follows its end keeps following, so the page does not jump; a panel taller than
a third of the view pauses following as before.

Consecutive actions between two pieces of narration form a run. A run of two or more
gets a summary row, with a pencil if it holds an edit and otherwise the icon of its most
common kind, and a counted label in order of first appearance: "Edited a file, ran 2
commands", "Read 4 files", "Searched 3 times", "Used 2 tools" (a file counts once however
often it was edited; live it reads "Editing a file, running commands"; a failure adds
", 1 failed" so a folded run does not read as all done). A run is open while it works,
and a run the person watched work stays open when it ends (the block around it folds, so
it shows again when the person opens the block); a restored run of five or
fewer is open and a longer one folds to its summary. The person's choice is kept with the turn's other disclosure choices. One
action is just its row, and the run no longer scrolls inside a box.

`/preview?activity=1` adds saved replies of every shape above and `/preview?live=1`
plays a running turn (`&hold=edit` stops it while the edit is under way).

### Streaming a long reply

A streamed reply is drawn in pieces. Its text is cut at blank lines outside code, and each
finished piece keeps its parsed tree while only the last one is parsed again. A text with a
link or footnote definition, an HTML block, indented code that a list follows, or a bare CR
line ending is never cut. A reply that is still streaming changes what is drawn at most every
50 ms; a settled reply shows its text at once. A turn that is not being written is not drawn
again for a streamed delta, and a finished turn away from the end uses
`content-visibility: auto`, so find, selection and `scrollIntoView` still reach it. The two
newest turns are never skipped. No virtualisation is used.

The transcript follows the end while a reply grows. A scroll the code makes itself is not read
as the reader leaving the end. Opening a disclosure stops following while it grows and follows
again only if the reader is still at the end. Each conversation remembers its scroll position and
whether it was at the end.

In a real Chromium with 300 settled turns above a 788-delta reply, production React went from 323
long tasks (19.8 s) to 2 (0.6 s), main-thread time per delta from 34 ms to 6 ms, and the largest
gap to the end while streaming from 4,915 px to 161 px. The method, both React modes, anchor checks
and the work that remains outside the transcript are in
[the streaming measurements](../../research/transcript-streaming-20261007/README.md).
The preview's `/preview?stress=300` flag adds the long conversation and a timer-driven streamed
reply for repeating them.

The [reference observations](../../research/runtime-desktop-20260930/artifacts/transcript-reference-observations-20261006.json)
record the installed Codex build's verified source labels and motion constants.
Its live transcript DOM was unavailable without restarting that application,
so these observations do not establish pixel parity with a running reference.
The [transcript browser proof](../../research/runtime-desktop-20260930/artifacts/transcript-reference-motion-proof-20261006.json)
uses the actual Namzu renderer with synthetic runtime events, deterministic
animation frames, keyboard disclosures, rapid reversals, reduced motion and
Pal separation. It performs no native, model or computer action.

Cancellation, pause, refusal and error end the live phase without claiming a
successful answer. The exact runtime reason preserves Paused even when its ACP
stop category is `cancelled`. When preparation returns without a streamed end,
the native host admits the prompt response as the missing end once. A streamed
end followed by its response does not create a second completion. Pending
reviews are cleared; authored queued messages remain available after a stopped
turn.

A successful configured `stop_condition` does not produce an incomplete-work
notice. Execution policy refusal is separate from an operator decision;
unmeasurable cost, answer review and plan review have their own explanations.
Pause/stop/timeout notices do not promise recovery. Only the authoritative
recovery controls below decide whether a turn can be retried or resumed.

Checkpointed provider faults retain their failure explanation in the live
transcript's error alert even when the compatibility stop category is
`cancelled`. Reopening that conversation while its runtime connection remains
alive retains the explanation; the next authored prompt clears it. Ordinary
review pauses and user cancellation do not create an error. Cold history restores
recorded terminal classifications and bounded public receipt views. It does not
restore raw provider fault text, a live permission or retry authority.

The desktop offers **Retry turn** only when the connected runtime confirms an
exact retryable provider checkpoint with resolved request accounting and known
original approval settings. Retry continues that original turn, using its
retained model and settings, without submitting another message or its
attachments. The current draft and authored queue remain available; Retry does
not consume or automatically start them. Its existing approvals and Stop action
remain effective, and moving a conversation preserves its window/pane writer
ownership. Stale checkpoints, user-decision pauses, unsafe accounting and
unverifiable original settings or Pal computer lifetimes show the runtime's notice instead of a Retry
button. A request with unresolved usage needs its actual provider usage receipt;
Retry does not fabricate usage or abandon the turn. Older CLI connections do not
offer this route. Ordinary new-message admission checks the paused status before
clearing drafts/files or appending an authored prompt; a follow-up is never
silently substituted for retry.
Admission remains reserved through the final status read and authored-queue
handoff. A concurrent send retains its draft, and engine, model and plugin
changes wait for admission/settlement to finish. Settings revisions and connection
ownership fence replies that arrive after metadata changes.

The host captures an original Pal computer's generation and environment identity
before sending, then checks that exact lifetime at status and resumed provider/tool
entries. Reboot, replacement, retirement and operator takeover refuse Retry. The
original approval options and computer lifetime are not currently durable; after
host reconnection this action is unavailable when either cannot be verified. A
currently ready computer does not substitute for the original one.

Elapsed time uses the native host's timestamps at prompt admission and turn
settlement. It includes preparation, model work, tools and approval waits; time
spent in an unstarted message queue is excluded. This is observed wall-clock
elapsed time, not provider compute time, billed latency or the sum of tool
durations. Clock adjustments can affect it. Reattaching the interface preserves
the same timestamps and settled duration while main lives. Cold ordinary history
can display an explicitly recorded runtime duration, with a tooltip identifying
it as saved work time. This is distinct from the native host admission clock;
the desktop does not invent historical start/end timestamps or reconstruct
reasoning bodies. Legacy history with no saved timing keeps it absent.

Message and work-row timestamps now preserve their source. Live updates retain
the native host's first observed time and actual observed settlement; cold
history uses validated journal timestamps attached to the same message/turn/tool
identity. Bounded history rows retain a journal message ID only when that ID
passes validation; older rows without a known ID remain readable. The clock
tooltip distinguishes **Observed by Namzu** from **Recorded
in conversation**. Reopening or switching tabs does not replace these values
with the current time. Missing legacy clocks remain absent. Timeline order still
follows admitted event/journal order rather than sorting by potentially adjusted
wall clocks.

Provider-hosted web searches/fetches appear as named work steps. Saved history
restores their actual terminal receipt and reported query/result count, including
conversations written before Desktop displayed those events. A missing terminal
receipt stays interrupted. Provider result counts do not supply result titles or
URLs. Assistant citations open only validated HTTP(S) links through main's
authenticated system-browser bridge, after a user click; remote message media
and privileged renderer navigation remain blocked. A sole HTTP(S) source URL in
inline code remains styled as code and opens through the same bridge. URLs in
fenced code, commands and unsafe schemes remain inert.

Work details use a compact rail of steps in admitted turn order. Exact
`search_conversation` actions say **Checked earlier messages**; their query
strings are available in the explicit detail rather than being mistaken for
tool names. Qualified provider-hosted search receipts say **Searched the web**.
Routine completion labels and exact row clocks stay visually quiet; hover and
keyboard focus reveal time and duration without replacing their recorded
values. Failed and waiting states remain visible. The outer live summary reports
**Working for** the observed elapsed time while actual Thinking or approval
waiting remains a separate status; settled work uses the saved outcome and
duration.

Design evidence comes from inspected WAI seeded UI and the public
[Beautiful UI](https://www.beautifului.dev/) Thinking, Tool Chips and Sources
examples, plus [AI Elements](https://elements.ai-sdk.dev/components/chain-of-thought)
and [shadcn Item](https://ui.shadcn.com/docs/components/item). These are component
and layout comparisons, not proof of execution or a claim of pixel parity.
The [research and renderer checks](../../research/transcript-search-timing-20261007/README.md)
record inspected states, actual source-derived fixtures and supported window sizes.

Streaming follows the latest message only while the reader is at the bottom.
Reading older output preserves its position as new messages arrive. A small,
keyboard-accessible **Jump to latest messages** control returns to the end and
resumes following; reduced motion uses immediate movement. Warm tab navigation
restores the saved reading position. Ordinary conversations also retain only
work disclosures the reader explicitly opened or closed, including an explicit
closed choice; untouched work keeps its live-open and settled-closed defaults.
These per-conversation choices are bounded and restored before the saved reading
position, including after reopening the app. Pal chat has no ordinary work
disclosure choices. While a retained history refresh is pending, a reader's
new wheel, keyboard, touch or disclosure action takes precedence over the old
saved position. Leaving before history finishes preserves that conversation's
saved position instead of writing the shorter loading view's offset. Ordinary
programmatic scroll events do not count as reader actions. Settled Markdown
bodies retain their parsed subtree when
only a live body changes. The [disclosure persistence proof](../../research/transcript-motion-20261007/artifacts/disclosure-persistence-e0661714-2e79d0ad.json)
checks independent owner choices, cached tab return and a held authoritative
history reload with the same reader anchor and follow state. The [held-history race proof](../../research/transcript-motion-20261007/artifacts/pending-scroll-races-e0661714-9b0eaf9b.json)
checks real reader input, programmatic scroll and a conversation switch before
the held read settles. The earlier [renderer proof](../../research/desktop-autonomy-20261007/artifacts/desktop-reading-browser-proof.json)
checks follow-scroll, ordinary background indicators, narrow light layouts and
the separate Pal chat, without model requests or computer actions.

## Files beside a conversation

The conversation's right panel is resizable (320 px up to 70% of the pane, width kept per pane) and holds one ordered list of tabs: Changes, Activity and one tab per open file. All of them are ordinary closable tabs drawn by the same component (an icon, a label that truncates, a close button that shows on the active tab and on hover or focus, a middle click that closes); the active tab sits in a bordered, raised box and the others are plain muted text. Activity carries a small count while background work is running, in the warning colour when something needs attention. Arrow keys, Home and End move between tabs; Delete or Ctrl+W (Cmd+W) closes the focused one. The list and the active tab persist per conversation; a conversation saved before tabs existed gains Changes and Activity in front of its files and keeps the tab it was showing.

The "+" opens a menu: Changes and Activity (each only while closed) and, after a separator, "Open file…", which opens quick open with the filter ready. "View changes", an edit card's rows and the details popover's Changes add the Changes tab at the front if it was closed and show it with the requested scope; the popover's Background work does the same for Activity. Closing the last tab leaves an empty panel with three quiet buttons (Changes, Activity, Open a file); the panel stays open until it is hidden. At the right of the strip, "Expand panel" / "Restore panel" makes the panel fill the pane and hides the conversation (Escape does not undo it, and the state is kept per conversation with the rest of the view state), and "Hide panel" closes the panel as the old close button did.  A file opens as a Markdown document (its YAML front matter as a Metadata table, "View source" for the raw text), as highlighted source, as an image, or as a plain note with "Open in" when it is binary or larger than 2 MiB (images: 4 MiB). A filter box searches the project by fuzzy match; below it a lazy folder tree shows the project. When a turn settles, the open file and the tree read the disk again.

Replies turn paths and `code` spans that name a real project file into links that open the file at its line. Nothing becomes a link in a chat without a project or in a Pal conversation, and a reference that does not resolve stays plain text.

Every file call is confined to the folder of a trusted, ordinary project that the main process looked up by id; the renderer never supplies a root. These calls read the folder directly, so they do not need the project's Namzu connection. A path is refused when it is absolute, has a `..` segment, a control character, a drive letter, a UNC or `~` prefix, names `.git`, or resolves through a link that leaves the folder. Errors are plain sentences without paths.

The same visibility rules apply to listing, searching, reading and linking. `.git`, `node_modules` and anything matched by `.gitignore` files (root to the folder) or `.git/info/exclude` is neither listed, indexed, linked nor readable by exact path, so a secrets file the project keeps out of version control cannot be fetched by naming it. A link inside the project that points at such a file is judged by where it lands. Reads open the file without following a final link and without blocking on a named pipe, and check after opening that the path still resolves to the opened file; a folder swapped for a link in the instant between the check and the open can still not be ruled out, because Node has no `openat`-style descent.

The project index is a bounded walk (50,000 paths, depth 24, a 3 s budget checked inside each folder too) cached for 30 s, and it reports `truncated` when a cap was hit. "Open in" finds VS Code and Cursor in the per-user install folder, under Program Files and on `PATH`, and starts the first one found with separate arguments and no shell.

## Sidebar, tabs and the command palette

**Sidebar.** The **Projects** heading carries the one **Add new project** button (a menu: *Start from
scratch* or *Use an existing folder*); the workspace menu no longer repeats it and an empty sidebar says
"Use + to add a project." instead of offering a second button. A project row has a **…** button (also the
right-click menu) with **Open folder**, **Archived conversations** and, last, **Remove project…**; there is
no one-click ×, so nothing starts a removal by a stray click. Each conversation is listed once: it sits
under its project, and **Recents** holds only the conversations a project's list is not showing (a
collapsed project, or the ones behind *Show more*), each with its project's name beside the title; Recents
is hidden when nothing is left for it. Opening a conversation from Recents does not expand its project.
Clicking a project row reuses the project's untouched "New conversation" (also after a restart) instead of
adding another empty tab. **Archived conversations** is a row at the bottom of the sidebar (and in the
palette and the project menu): one dialog for every project, grouped by project, newest first, with
**Restore**. A project that cannot be read says so and does not hide the others. Row titles are cut at a
word (26 characters in a tab, 34 in a row) with `…`, and the full title is the tooltip. The hover card
under a row says which engine answers, the last message when this window has it,
the project and the branch; it opens below the row, inside the sidebar, so it never covers the
conversation. The close, pin, archive and menu buttons at the end of a row are centred on the row
(`e2e/ux-sidebar-tabs-terminals.test.mjs` measures them at 100, 125 and 150% zoom, dark and light).

**Archiving.** The menu entry reads **Archive** (no ellipsis: it acts at once). The toast says
"Conversation archived. Find it under Archived conversations in the sidebar." and stays 20 seconds with
**Undo**.

**Tab strip.** The tab in front scrolls into view when it changes and when the pane is resized; tabs
shrink to 160 px before the strip scrolls; when it scrolls, a **Show all tabs** button lists every tab with a
check on the one in front. A caret beside **+** ("More ways to add a tab") opens the same menu as the
right-click on **+**. The menu of a terminal tab also offers **New terminal to the right** and **New
terminal below**. When a split needs more room than the pane has, the docked sidebar closes first
(remembered, like the toggle) and, if even that is not enough, the window says it is too narrow; the page
never scrolls sideways. A split made while a terminal is in front leaves that terminal in front.

**Keyboard.** Ctrl+W closes the tab in front (⌘+W on a Mac), Ctrl+Tab and Ctrl+Shift+Tab (or Ctrl+PageDown
and Ctrl+PageUp) go to the next and previous tab, wrapping; Ctrl+1 to Ctrl+8 pick a tab by position and
Ctrl+9 the last one (⌘ on a Mac); Ctrl+Shift+PageUp and Ctrl+Shift+PageDown move the tab left and right;
Ctrl+Shift+backslash opens a terminal to the right. Inside a terminal these chords leave for the window,
except Ctrl+W, which stays the shell's (delete a word): Ctrl+F4 closes the terminal tab there. Ctrl+, opens
Settings from a terminal too.

**Command palette** (Ctrl+K). The box reads "Search conversations and actions"; the groups are **Recent**
(the five newest conversations), **Conversations**, **Actions**, **Tabs** and **Projects**, and nothing is
listed twice: a conversation never written in (a new draft) is not a conversation. Actions: new
conversation and terminal, the four split entries, **Find in terminal** (while a terminal is in front),
rename, pin and archive the conversation in front, **Archived conversations**, **Settings**, **Add
project: start from scratch** and **Add project: use an existing folder**; Tabs: close, next, previous,
move left and right. A chord shows as one keycap, written as the menus write it (Ctrl+Shift+backtick). Closing
the palette puts focus back where it was, or in the composer.

**Search.** Every search box folds text the same way, whatever the system language is: the text is
decomposed, accents are dropped, the dotless `ı` counts as `i`, and then it is lower-cased, so `I`, `ı`,
`İ` and `i` match each other (`IŞIK`, `isik` and `ışık` find both "Işık raporu" and "ışık ölçümü"), and a
Turkish Windows does not turn `SETTINGS` into something that matches nothing. This covers the palette,
Settings search, the project picker, the plugin list and the model picker (`renderer/text-fold.ts`).

**Scroll.** A conversation's scroll position is saved with its view when the reader stops scrolling and
when the window closes, so it reopens where it was left after a restart.

## Terminal tabs

A terminal is a tab beside the conversations. It runs on this machine, in the project folder, as
you, so it needs a trusted folder like the agent's own tools do. The processes belong to the
project's CLI host (see [Host terminals](#host-terminals)); the window is a view of them.

**Opening one.** The terminal button beside the tab strip's **+** ("New terminal tab"), the command
palette's **New terminal**, and Ctrl+Shift with the backtick key (⌘+Shift on a Mac) open a shell. The tab joins the pane
that has focus and shares its strip with the conversations, in the order you put it: it drags,
splits (**Move to right pane**, **Split down**) and moves to a new window like a conversation tab,
and the sidebar lists it under its project with a terminal mark. Two shells of one project are told apart by the shell, a number and the folder (`sh · app`, `sh 2 · app`). The pane has no header of its own: the terminal fills it, the tab (strip and sidebar row) carries the title and status, closing is the tab's close, and the region is still named `<title> terminal` for assistive technology. A click on the pane's dead space hands the keyboard back to the program. The terminal on screen is made once
per tab and kept while the tab is in the window, so switching to a conversation and back costs
nothing and keeps the scrollback; reloading the window rebuilds the screen from the host's snapshot.

**The shell.** Linux and macOS open `$SHELL`. On Windows **Settings ▸ General ▸ Default terminal
shell** chooses `Automatic`, `PowerShell 7`, `Windows PowerShell`, `Command Prompt` or `WSL` (only
what is installed is offered; a missing choice falls back to `Automatic`). `Automatic` is PowerShell 7
when `pwsh.exe` is found and otherwise Command Prompt switched to UTF-8 (`cmd.exe /d /k chcp 65001>nul`),
never Windows PowerShell 5.1, which silently drops a typed `İ`. **Bring terminal tabs back** (default
on) decides whether tabs return after a restart; while it is off no screen is kept at all: nothing is
written to `terminal-tabs.json`, and turning it off removes what an earlier run left there, because a
saved screen can hold what a program printed or what was typed into it, a token included. A program's
environment is the app's own: variables you exported, API keys included, reach a terminal as they do in
any shell, and the Namzu engine tab also carries `ELECTRON_RUN_AS_NODE=1` into its descendants, so an
Electron program started from that terminal's tools behaves as plain Node.

**The view** is `@xterm/xterm` with the fit, WebGL (the DOM renderer takes over when the context is
lost), Unicode 11, search and web-link add-ons, drawn from the app's own tokens in both themes (the
background and text are the app's, the sixteen colours differ per theme). Links open through the same
`openExternal` allowlist as every other link, including the links a program draws with the
hyperlink escape (OSC 8), which never raise the emulator's own confirm-and-open; the address shows as
the tooltip while the pointer is over a link. Pasted text has its control characters removed (escape
and the 8-bit controls, so it cannot close a bracketed paste and continue as typed commands), and
several lines pasted into a program that did not ask for bracketing ask first, in a note inside the pane that is announced and has **Paste** and **Cancel** (no native box). Text is drawn at a minimum
contrast of 4.5:1, selected text has its own opaque colours, and an ended session hides its cursor. Almost every key belongs to the program, including
`Ctrl+K`, `Ctrl+N` and `Escape`, which the rest of the app uses elsewhere: the pane stops them at its
edge. The exceptions are `Ctrl+C` (the interrupt, unless text is selected, then a copy; `Ctrl+Shift+C`
always copies), `Ctrl+V` and `Ctrl+Shift+V` (paste, bracketed when the program asks), `Ctrl+F` (a small find overlay inside the terminal, announced when it opens; `Escape` closes it), the new-terminal chord (Ctrl+Shift+backtick) and the window's own chords: Ctrl+, for Settings and the tab chords above; on a Mac the same chords use `⌘`. The terminal follows the pane's
size: the view fits itself, tells the host, and the program and the host's own screen resize together.
Only one view types into a terminal; a second window that opens the same tab watches and offers
**Take over**; when a window reloads, navigates or closes, its views are released so the new page
holds the keyboard at once. A terminal never outlives the trust of its folder: when the folder's
automatic settings change (or trust is withdrawn), the project's terminals are ended, and opening one
repeats the changed-settings check first, for a shell as well as an engine tab.

**Restart.** A running program does not survive the app closing. On quit each terminal's last screen
is read from its host and saved with the tab in `terminal-tabs.json` (a serialized screen over
512 KiB is dropped, and the file is written a few seconds after output goes quiet and at least every 12
seconds while a program never does); on the
next start the tab returns in the layout as an **ended** session showing that screen, with a line that
says why it is quiet and **Close tab**. A layout tab with nothing saved behind it is removed. Closing
a tab, or removing its project, ends the whole process tree.

### Desktop | CLI

The composer's engine popup has a two-way switch beside the engine chip. **Desktop** is the
conversation in this window, unchanged. **CLI** turns Send into **Open &lt;engine&gt; in a terminal**:
it opens a terminal tab titled *engine · project* that runs that engine's own command line in the
project folder with the composer's choices, and starts no conversation here. The switch is offered in
a trusted project for an engine conversation that has not started (a started one keeps its engine);
the choice is remembered per window.

| Engine | Program and arguments |
| --- | --- |
| Namzu | the bundled CLI as the terminal's program (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`, the Desktop runtime's Node flags, then the entry): `--provider <id> --model <id> --effort <level> --permission-mode <mode>`. The [launch flags](launch-flags.md) apply to that session only and never write `preferences.json`. The composer's text goes as `--message=<text>` (one argument, never re-parsed by a shell): the session sends it once, as a plain prompt, when its composer is ready, and shows it as the first user message |
| Codex CLI | `codex -m <model> -c model_reasoning_effort=<level>` and the approval and sandbox flags below, then `-- <message>` |
| Second engine | its own program `--model <id> --effort <level> --permission-mode <mode>`, then `-- <message>` |

An effort the engine does not offer is left out and named in a notice (`Codex CLI started without
the max effort.`); a model that was only the engine's default is left to the engine. The composer's
text is every engine's first message, and is cleared from the composer only after the tab opened and the message was passed. On Windows, text Command Prompt would read as syntax (`& | < > ^ % " !`, a backtick or a line break) or a line over 8000 characters is not passed: the engine still opens, the text stays in the composer, and a notice says so in one line. Plain words, `. , ? ' : ( )` and Turkish letters pass.

| Desktop mode | Codex CLI | Second engine |
| --- | --- | --- |
| Ask first | `-a on-request -s read-only` | `--permission-mode default` |
| Edit automatically | `-a on-request -s workspace-write` | `--permission-mode acceptEdits` |
| Full access | `-a on-request -s danger-full-access` | `--permission-mode bypassPermissions` |
| Preapproved only, Plan only | `-a never -s read-only` | `dontAsk`, `plan` |

Codex's `-a` flag accepts only `on-request` and `never`, and the installed Codex (0.161) refuses to
start with `-c approval_policy=untrusted` (`approval_policy = "untrusted" is no longer supported`), so
the two stricter modes ask on request under a sandbox that cannot write, or writes only in the workspace.

**Windows.** An engine installed as a native `.exe` is the terminal's program. An npm `.cmd` shim, and
the bundled CLI (Electron's executable prints nothing when it is the program itself), run as
`cmd.exe /d /c call <program> <arguments>`; `call` keeps Command Prompt from stripping the quotes of a
program path that holds a space. Command Prompt is started by its absolute path (`%ComSpec%`, else
`System32\cmd.exe`), never by name, because a bare name is searched for in the project folder first; for
the same reason the Namzu terminal is not offered on Windows without the bundled CLI, since a bare
`namzu` could be a file planted in the folder. Command Prompt reads `& | < > ^ % ! \``, a quote and a line
break in that line, and ends the line at 8,191 characters, so a launch holding one of them is refused, and
a message holding one of them, or one that would take the line past 8,000 characters, is left in the
composer instead. A provider or model that begins with a dash or holds a control character is refused
before anything is built.
`codex` and `claude` are found on `PATH`, `~/.local/bin` and `%APPDATA%\npm`.

### Status badge

An engine's tab carries a dot (its accessible name says it in words) for what its program is doing, read
from nothing but its output and its end: **Working** (output in the last 1.5 s, or just started),
**Waiting for input** (it printed and went quiet), **Idle** (quiet for a minute) and **Exited** (red,
`Exited with code N`, when the code is not zero). When an engine's program ends with a non-zero code
a quiet notice names the tab and the code. The badge cannot yet tell an approval prompt from a
finished answer; that needs the screen and is a later step. A plain shell has a badge only once its session has ended (a hollow ring, "Session ended"). The dot's meaning is its tooltip, and the sidebar row's tooltip reads `<title> — <meaning>`. When Namzu's own update of an engine or of the command line finishes successfully, its terminal tab closes by itself; a failed one stays so its output can be read.

Screenshots of the tabs, the switch and the badges in both themes are in
[`research/terminal-20261008/`](../../research/terminal-20261008/), made by the real-Electron flows in
`packages/desktop/e2e/terminals.test.mjs`.

## Operator flow

Open a folder. If it is not already trusted by Namzu, the app shows its exact
canonical path and one native confirmation immediately after folder selection,
before allowing project access. Existing trusted folders do not ask again.
A new protocol session alone never grants trust. Cancel keeps the folder
untrusted, with an explicit action to review access again. Folder trust is
separate from the selected conversation's tool permissions and execution engine.
The composer project menu searches existing ordinary projects by name or path;
Don't work in a project opens the app-owned ordinary chat context. Neither
project navigation nor opening the permission menu grants folder access.

Choose a saved conversation, or type directly in the selected project’s blank
composer. New conversation, Home and the tab plus button create a blank ACP
conversation slot in a ready trusted ordinary project; neither a model nor an
external engine starts until a prompt is sent. Disconnected or untrusted contexts
show the blank landing composer until preparation is possible. Ordinary peer tabs
retain separate drafts, models, queues and approvals. Closing a tab only hides its
view; reopening a recent conversation restores it. The mouse middle button on
an ordinary, Pal chat or computer tab label invokes the same close operation as
its existing X button. Nested menu/profile controls do not trigger middle close;
computer-view close does not stop the guest.

Opening a saved or newly customized Pal checks that its exact workspace client
is still current and ready, both before and after the conversation catalogue
read. Failed setup retains its original diagnostic and saved profile; it does
not attempt a new conversation, claim or computer start. An explicit reopening
can retry the same profile.
Retrying a disconnected, previously verified Pal reopens its current approved
profile, retaining its stored workspace spelling and existing project id.
A deleted profile is refused before a replacement client is started.

Archive is available in the conversation actions menu, ordinary tab menus and the
action menu on project/Recents rows. A confirmation says the conversation leaves the
sidebar and its history stays saved on this computer. Inactive Recents removal does not open or prepare the model.
Main verifies the selected project and each actual stable/runtime journal alias,
refuses active/queued/review/background/recovery work and uses the existing scoped
archive writer lease. For an ordinary native engine, only its matching idle writer
is closed before the archive; an in-memory reservation blocks new engine/model
admission until the archive settles. A failed close keeps the native owner for
retry. Claimed Pal journals retain their existing scoped path. Unknown or corrupt
journals keep the conversation visible.
A never-prompted local conversation is removed without claiming archival only
when every owned alias is confirmed absent. An acknowledgement retires the view
and tabs in every window; errors keep the dialog and retry choice. This is not a
journal or file purge. [The renderer removal proof](../../research/runtime-desktop-20260930/artifacts/removal-dialog-browser-proof-20261006.json)
uses isolated sample receipts; backend tests separately exercise real scoped
journal and cleanup behavior.

The [native Windows harness and removal proof](../../research/runtime-desktop-20260930/artifacts/native-harness-ui-proof-20261006.json)
records real answered turns through Namzu's free route, Codex CLI and the second external engine,
including model and effort changes. Ten warm model-popup reopens made no additional
catalogue RPCs. A subsequent GPT Luna turn and inactive Recents deletion confirmed
durable archival; a fresh, model-free Pal was created and deleted through the UI,
with its files and ordinary tabs retained. Earlier writer-release and Windows
path-spelling failures remain recorded separately. These tool-free turns verify
routes and selections, not actual write approval or sandbox effects for every
engine. The [deployment preservation audit](../../research/runtime-desktop-20260930/artifacts/pal-conversation-removal-semantic-audit-20261006-v8.json)
compares the original protected state across seven activation pairs and three strict
journal reads; it retains the earlier failed strict comparison and its explanation.
The final main-process update adds the verified Pal reconnect path. Its 86 Pal
tests and all 720 desktop tests pass; CLI/SDK runtime bytes remain identical to
the preceding native feature run. That update does not claim another model run.
The original window ceased during the isolated Pal run; its cause was not
established and that receipt's failed process-survival observation is retained.
A separate [normal-profile restoration check](../../research/runtime-desktop-20260930/artifacts/pal-conversation-removal-post-test-restore-native-20261006.json)
verifies the relaunched native window and exact protected state after read-only
Pal presence hydration, without rewriting the earlier observation.

Empty tabs are omitted from
the sidebar recent list. Suggestions fill the
editor for review rather than submitting a prompt. Navigation during creation
leaves the submitted prompt bound to its captured project and model; it cannot
redirect that prompt or switch the newly selected conversation. A failed provider
selection retains the created conversation and its draft for retry. Saved history comes from Namzu's
existing scoped logs and index; archived conversations cannot be resumed as
writers. The app's private records retain project paths, conversation identities
and acknowledged drafts separately from that history, without provider secrets.
Historical display is a bounded text
projection of the latest 200 messages/200,000 characters and marks a partial view.
The kernel loads the full admitted history for the model independently.

Provider and model choices use existing CLI credential discovery. Set up missing
credentials in Namzu. The desktop receives provider IDs, labels and default
model names, never keys or token objects. The engine view of the model popup chooses the
execution engine, before and after the first message. Namzu uses its wordmark without a duplicate text label and keeps
its own provider/tool runtime. `codex-cli` and `claude-code` use the installed native
engine and its actual model catalogue, surfaced under separate engine IDs. An
existing conversation keeps its durable engine; choosing another engine opens a
new peer tab. Selection is reflected immediately after the engine acknowledges
it, even if later model discovery fails. Model, permission and attachment
controls are disabled while engine selection is pending. A project reconnect
reapplies the exact engine and selected model for an unstarted native draft;
failure retains that draft and never replays its prompt through Namzu.
Failed saved-settings reads keep Send and model selection unavailable until
Retry setup retrieves the actual saved choices, rather than choosing a default.
Renderer reloads retain ordinary open tabs, groups and active conversations in
the main-owned window layout. Tab identities are revalidated against the actual
project and conversation catalogue before history, drafts and settings reopen.
Failed or incomplete restoration keeps the previous navigation for Retry setup
and disables Send/model controls; deliberate navigation starts a fresh view.
No model choice or draft text is duplicated in browser storage.

The permission chip beside "+" shows an icon and the current mode; Full access uses
the warning colour in the chip and the menu. It opens a popover titled "When should
Namzu (or Codex, or the second external engine) check with you?" with one row per mode the engine
supports: Ask first, Edit automatically (`accept-edits`, Namzu and Codex when the
engine reports it), Full access (`auto`) and Plan only (titled Read only for Codex).
Preapproved only (`strict`) appears only when it is the saved mode, and a saved mode
the engine no longer supports stays visible without changing the stored policy.
Arrow keys move the highlight; Enter, Space or a click chooses; Escape closes and
returns focus to the chip. Codex's Ask first mapping uses native read-only/untrusted
policy; it is not the current Codex app's workspace-write approval default, and
choosing Codex Full access requires an explicit confirmation for the captured
conversation. Full access is computer-wide native access without tool review;
Namzu Full access continues to respect Namzu's configured tool rules.
The initial `claude-code` adapter offers Ask first and Plan only. The app does not
offer Codex's automatic safety reviewer. Native engines disable attachments and
Namzu plugin toggles rather than discarding inputs.
See [native engines](native-engines.md) for installation, sign-in, cancellation
and recovery limits.
Composer height and transcript follow-scroll writes are coalesced into animation
frames and skipped when unchanged. Resize callbacks do not immediately change
the sibling transcript layout, so native approval banners can appear and close
without undelivered resize notifications. Pending writes are cancelled when the
view is replaced.
An installed executable does not prove that a usable account session was found.
See [provider credentials](credentials.md#existing-claude-sessions) for the
native Windows credential locations and explicit profile overrides.
Opening the model menu asks the selected
configured provider for its real catalogue through `namzu/providers/models`.
This uses the CLI's existing bounded listing and access filter;
anonymous routes do not offer models that require an account credential.
The result contains only actual listed model IDs, labels, optional notes and a
notice. Registry defaults and saved choices absent from that list are not added
as available rows. The current choice remains visible in provider status, with
an explicit notice when the catalogue omits it. A failed, timed-out or unsupported
listing returns no invented rows; its notice explains the failure and the
exact-model field remains available. Credential rejection has a distinct safe
notice without the driver's raw diagnostic. A published model
list is not proof that the account can run every listed model. Listings are read
on demand rather than delaying project startup, shared while one request is in
flight, and cancelled when the CLI connection closes.
The renderer additionally retains a bounded, two-minute catalogue display cache
for the exact window API, project, conversation, provider, available-provider
metadata and selected harness. Reopening its popup or returning to the same
conversation can show the retained list immediately. Matching concurrent reads
share their promise. Connection replacement, confirmed harness changes, project
removal and Retry setup invalidate the affected scope. A provider refresh and
failed-list Retry explicitly read again. Late replies cannot refill a retired
scope or appear under another conversation or harness. Merely changing a model
within a provider does not invalidate that provider's list. Codex CLI and the second
external engine echo the current selection in their provider `defaultModel`; that route
echo is omitted from the display key, while Namzu provider defaults retain their
catalogue identity. Metadata cannot
detect an external credential replacement that retains every visible field;
the short lifetime and explicit refresh cover that limit. Catalogue display does
not grant access: model selection, settings and Send keep their fresh exact
backend admission. The cache is not persisted to browser storage.
The account catalogue uses the driver's strict listing when available, keeping
an authentication or network failure distinct from its legacy bundled menu.
The menu has a provider column when more than one provider is available and
selectable model rows with their catalogue labels. A single provider uses a
compact list headed "Choose a model". The effort panel and the list share one width per
engine (300px, or 360px with a provider column) and the popover eases its height when
the view changes. A single-engine list of seven models or fewer shows no search, refresh or typed-id controls; the search icon appears with a longer list or several providers. The menu opens from the end of the model
control, with collision handling at the window edges. Provider glyphs stay in their
navigation column; model rows use their names and selected checkmarks. A long list shows only the current models first, in the source's order, then one
muted row "Older models (N)" that expands in place inside the same scroller and radio group (the
arrow keys continue into the older rows); a model that is checked but older stays visible under
the current rows. Search reads every row and ignores the fold. A row is current when the source
says so (`current: true`) or, by one pure rule in `model-choice.ts`, when it is the newest version
of its family (the label or id without its version numbers; a date suffix such as 20251101 equals
the undated id) and its major version is not behind the newest major of its maker (the first word of its name, so a mixed list keeps every maker's latest). A list of six rows
or fewer, or one with no parseable version, is all current in source order. The checked row is
the saved choice. The row the engine flags `default` wears "Recommended" while it is current;
a provider default that the catalogue merely echoes is never shown as a recommendation.
A choice saved under the retired `preset: 'default'` is resolved once to the row the engine flags
and is an ordinary choice from the next save.
Main keeps `lastModels` (engine to `{provider, model, label}`) in `desktop-conversations.json`,
written whenever a model choice is saved, and a conversation of that engine with no saved choice
and no prompt yet starts from it; a Pal and a started conversation keep their own. If the engine's
stored list no longer holds the model, main drops the entry without a notice. With nothing ever
chosen (no saved choice, no Pal model, no model in the preferences) a new conversation settles on
the recommended row, else the first current row, once its list is known. The CLI preferences file
is never written. The trigger names a model from the catalogue row for its id, then the saved
label, then the id, and refreshes a saved label that the catalogue renamed. The
catalogue is read as soon as the composer is ready, through the shared display cache. Repeated provider-wide notes appear
once; distinct model notes remain beside their models. Catalogue notices,
errors and Retry actions have a separate bounded scroll area above the custom
model action, so scrolling model rows does not hide the feedback.
Quick search searches model IDs, labels and provider names across the
configured providers; `/` opens search while the menu has focus. Arrow keys move the
highlight only; Enter, Space or a click chooses. Escape dismisses the menu and
restores focus.
Typing in Quick search keeps the search field focused. Arrow Down/Up enters the
first/last matching row; Enter, clicking or Space chooses a result. Choosing a model
closes the menu, unless the list was opened from the effort panel, in which case it
returns to that panel. Escape dismisses the menu and restores focus to the model
control. Profile-only model pickers have no effort panel.
Catalogue errors use a readable message and a provider-specific Retry action;
they do not expose raw driver diagnostics or imply that the catalogue is empty.
Fallback notices also remain visible in global search.
The provider tab browses its models without changing the current choice. Use a
model ID remains available for custom endpoints and models absent from a list.
Opening or searching the catalogue does not submit a model prompt or create a
conversation. Navigating to another project or conversation closes the menu.
An idle Pal can browse and choose models while its computer is stopped,
unavailable or paused. Catalogue access requires its own connected, trusted
workspace and loaded provider settings. Sending still requires a ready computer
and an unpaused Pal; active work continues to block model changes.
The Pal landing retains its saved model label while provider metadata loads.
Existing conversations retain their claimed model route rather than adopting
an edited Pal default.

Sending an idle turn applies the shown
choice before submitting the prompt. Failed selection is visible and prevents
sending on an unintended route. The CLI checks the chosen access path and
supported wire before closing the old model session; an anonymous Zen choice
that needs a credential leaves the previous conversation intact. New session
creation itself does not require a provider credential, so an unavailable saved
provider can be replaced before the first prompt is prepared.
Before that turn creates its journal, scoped model preparation accepts only
the normal session actually published on the current ACP connection with this
exact canonical workspace. Unknown IDs, foreign workspaces and stopped slots
remain refused; Pals still require their explicit durable claim.
A model change cannot silently kill active work.
Choices last for this connection and survive window reload, rather than editing
global CLI preferences. Existing fallback and delegation preferences remain in
force. Reload also restores live messages, pending reviews and queued prompts
from the main process; it does not restart the running turn.

The effort panel opens from the model control only when the actual model has two or
more known supported levels. It is a 300px popover above the control: a "Use default
effort" button on the left (disabled while the effort already equals the model's
default), the level named in the accent colour with the model's name beneath it as a
button back to the model list, and a discrete slider (Base UI) with one stop per
supported level, ordered from lower to higher effort, and "Faster" and "Smarter" beneath.
Arrow keys move one level, Home and End jump to the ends, and every move is saved at
once. The slider has focus when the panel opens, and Escape closes it and restores focus
to the control. The shown effort is the saved one while the model offers it, else the
model's reported default (muted in the trigger). Capability resolution includes
configured fallbacks. Changing the model keeps the saved effort when the new model offers
it and clears it, falling back to that model's default, once the new model's levels are
known and it does not. A settings read that failed decides nothing: the saved effort is
kept, and only the turn sent meanwhile leaves it off. These controls capture the model and conversation owner, so a late
interaction cannot modify another selection.
The underlying Namzu permission modes remain Ask first (`prompt`), Edit automatically
(`accept-edits`), Full access (`auto`), Preapproved only (`strict`) and Plan only
(`plan`). Full access remains subject to configured deny rules; Plan refuses
changes. Settings are captured with each submitted or queued message and do not
change the turn already running.

The attachment/settings popup exposes Attach images or files and Plugins.
Attach images or files opens the native chooser. Drop files into the editor or paste an image to add their actual
bytes. Supported native inputs are PNG, JPEG, GIF, WebP and strict UTF-8 text.
PDF and other binary files are currently refused in the desktop preview. Image
thumbnails open a full preview; each file has a removal action. A file-only
message can be sent. Each draft/message accepts up to eight files and 3 MiB in
total, with text limited to 128 KiB per file and 256 KiB combined. The main process
retains at most 24 MiB of attachment data across active messages, queues and
drafts. Native paths stay in main; file names, safe previews and bounded metadata
are the renderer's view.

Copied image previews in live message histories have a separate, profile-wide
budget of 16 MiB of encoded data URLs and 256 retained message references. Each
message copy counts, including repeated attempts with the same file. Reading an
owned projection promotes its retained previews; oldest references are retired
when either bound is exceeded. Retirement removes only the copied preview and
keeps the message, file name, media type and size. The image row says Preview
unavailable and offers no invented reload action. Revisioned retirement reaches
cached inactive conversations and other windows, and is replayed over an older
in-flight history response. A window that closes during delivery does not block
retirement in the remaining windows. Admitted provider bytes, chooser/draft files, queued
files, retry files and SDK durable history remain unchanged. This bounds encoded
message previews, not total process memory, in-flight IPC copies or decoded image
surfaces.

Files belong to their captured project or conversation. Changing folders during
a chooser cannot redirect its result. The first Send moves its draft files and
choices into the created conversation, including a failed route-selection retry.
Window reload and application restart restore acknowledged unsent text, files,
model and settings from private desktop storage. A queued message keeps its
original bytes and settings while main lives; Edit restores
them, and Remove releases its files. Cancellation or a provider error returns
active files to the draft for retry. Images reach the actual user-message path;
text files become labelled authored prompt content. The app checks the CLI's
attachment/options capabilities before consuming a draft, and refuses unsupported
explicit requests instead of silently losing their content.
The CLI also refuses new image/document inputs when the selected live provider
explicitly declares that it cannot receive them. Files remain available for
retry with a suitable model. An unknown declaration is not presented as proof
of model support.

Plugins shows installed manifests before the first turn without importing plugin
modules or creating a runtime. After a conversation starts, it displays actual
loaded states. Enable/Disable operates only on an idle conversation without
pending reviews or running background jobs. Choices survive that conversation's
model changes and remain session-local; they do not update startup configuration.

Tools stream their registry-owned presentations. A pending batch is answered in
the approval card attached above the composer; it answers the whole batch, and
"1 of N" shows when several reviews wait. The title names the call: "Edit
routes.ts?", "Create README.md?", "Delete x.ts?", "Run this command?" or "Allow
web fetch?", with the full path as a tooltip and `+N −M` line counts for a file
change. A file change shows an `@pierre/diffs` unified diff (line numbers, the
theme of the Changes tab, at most 280 px tall with a "Show more" toggle up to 60
percent of the window; a diff past the Changes tab's size gate falls back to its
plain patch). A command shows in a monospace box; any other tool shows a readable
key and value list. Details keeps the exact inputs, and a destructive call keeps
a warning line. The footer, right-aligned, holds a wrap toggle (only for a diff),
**Edit**, **Reject** (red text) and **Accept** (green text). Reject sends a plain
reject. Accept approves. Edit turns the footer into a one-line field, "Tell Namzu
what to do instead", with Send and Cancel: Send rejects the call and the model
reads "The user declined this change and said: <your note>" (at most 4,000
characters in all), and the turn goes on with that instruction. Escape cancels
the field. Ctrl or Cmd+Enter accepts only while focus is inside the card; nothing
listens on the window, and the card never takes focus from the composer.

The diff comes from the CLI, which dry-runs the SDK's own `dryRunEdit` (or the
`write` body) against the file as it is, so what the card shows is what the tool
will write. There is no preview, and the card says "Preview not available" with
the change as the call described it, for a file over 1 MiB, a binary file, a path
outside the turn's directory, a call the tool would refuse, and for the Codex and
external engines, which send none. The renderer API answers with
`respondPermission(sessionId, requestId, { outcome: 'approve' | 'reject', feedback? })`
(this replaces `approve`); the main process rejects a note longer than 4,000
characters and a note on an approval. A reject from the window also carries `note`,
the text as the person typed it (apart from the sentence that wraps it for the
model in `feedback`), and the main process tells the agent over ACP that the
person declined (`declined: { note? }`). The kernel records that on the call, so a
declined call is durable: its row reads "Declined edit to app.css" (or "Declined
command", "Declined read of x") in the muted state `declined`, with "Declined" as its
status, and opening the row shows "You said: *note*" when there is one. A row of
declined calls folds to "Declined 2 actions" rather than counting as edits or
commands, and its file name does not open the Changes panel, since nothing
changed. After a reload the same row comes back from history, because the recorded
presentation names the call's target and holds the note (at most 4,000
characters). A call a policy refused (strict mode, plan mode, an unattended
refusal, the authorization gate) is not marked, and its row stays "details
unavailable" after a reload, as it was; so does a call a TUI user declined, since
the TUI does not report that yet.
Follow-up drafting and queuing remain available while a
review waits. Cancellation aborts its permission wait. Approval IDs belong to
the conversation that asked; navigation does not redirect an answer to another
conversation. Background work shows session-owned shells, retained output and a
stop action. It does not list or stop another session's jobs. In ordinary Activity,
Background processes uses compact command rows, a confirmed running count and
state badges. Running rows appear first; retained finished output remains
inspectable while that CLI runtime owns its registry. Completed job buffers are
not persisted across a CLI restart. Done requires exit code zero; a missing exit code is only Finished.
The full command remains accessible when its visible label truncates. Hover or
keyboard focus reveals the named process's stop action; touch keeps it visible.

Each row opens its own bounded output snapshot, with explicit empty/truncated
states and a refresh action. Polling does not discard an open row or its output.
Read and stop responses belong to the session, navigation generation and job;
late output or errors cannot appear in another conversation. Pending actions
stay tracked during window close. Stopping waits for a fresh registry snapshot
after any older in-flight poll; failure never fabricates a stopped state and
unconfirmed termination keeps its retry action. A failed process-list read is
unconfirmed, rather than a zero running count.

Tabs and Recents also show a compact indicator for observed background work in
another ordinary Namzu conversation. One main-process observer serializes reads
across windows, starts at most one per second and refreshes a confirmed running
session no more often than every two seconds. Confirmations expire after 15
seconds and become unknown; terminal failure and zero-running confirmations do
not poll repeatedly. Owned conversation opening, tool settlement and stop actions
can seed a fresh observation. A late read cannot revive a removed conversation,
an old connection, runtime alias or harness. Closed process panels do not keep
their own polling loop. This display metadata never supplies stop, archive,
computer-idle or permission admission. Pal views and externally owned native
engine processes do not receive a Namzu shell-registry indicator.

The [background work reference observations](../../research/runtime-desktop-20260930/artifacts/background-work-reference-observations-20261006.json)
record the installed reference's compact process section and the limit of its
source-only inspection. Namzu retains its own named-job controls and output
history. The [background processes browser proof](../../research/runtime-desktop-20260930/artifacts/background-processes-browser-proof-20261006.json)
checks overlapping reads, failed/retried stops, poll ordering, navigation,
long commands, narrow and short layouts, light/dark themes and reduced motion
without native, model or computer actions.

The [native live-work audit](../../research/runtime-desktop-20260930/artifacts/desktop-live-work-verification-20261006.json)
verifies the final built desktop and history handler, exact original message
bodies, saved choices, drafts, files, tasks, profiles and computer control.
The private strict restart comparisons remain failed: live tool presentation
and completed registry buffers are not persisted, and the corrected tool-only
media placeholder intentionally disappears. The supplemental audit records
these differences rather than claiming identical live projections.

Enter sends; Shift+Enter adds a line. IME composition does not submit. While a
composition is active, global Escape and other shortcuts do not cancel work or
open another surface. During a supported ordinary Namzu turn, text-only Send
admits the message to that turn's scoped inbox. A waiting delegated-agent call
can release its wait while the child continues, and the runtime consumes the
input at a legal conversation boundary. Admission and consumption are separate
receipts; neither promises a particular response time or cancels the child.
The composer also offers explicit queueing for the next turn. Native harnesses,
Pal chats, attachments and older runtimes retain next-turn queueing when live
input is unavailable. The existing `send` API keeps that behavior; the optional
`sendCurrent` action requests current-turn delivery. Existing queued messages
are never silently promoted into live input.

Queued prompts are visibly separate from started prompts. Open the queued-message count to inspect every pending
message, edit one or remove that exact item. Stop preserves queued text. Edit
latest (Alt+Up) returns an authored queued prompt to the composer; a non-empty
draft must be sent or cleared first, so editing cannot discard unrelated text.
A message that has already started cannot be edited or removed from the queue.
Current-turn admission captures the exact run, connection, runtime session and
opaque prompt scope. A stale scope or unsupported payload cannot authorize a
replacement turn. Acknowledged input is reconciled against consumption receipts
when the turn settles; unconsumed text returns to its unchanged composer draft,
or to the next-turn queue when a newer draft needs preservation. An unreadable
acknowledgement or status retains the text for review. A queued uncertain input
requires an explicit edit before replay; it never starts automatically. These
receipts and the queue are connection-local and do not persist across quitting.

Unsent drafts belong to their conversation or to a blank project composer scoped
to its window and tab group in the main process. A blank project draft survives
renderer reload and application restart without creating a session,
even when its conversation catalogue cannot currently be read. A newly selected
project waits for its own provider catalogue before allowing Send; the previous
project’s model route is never used during that load. Suggestions are hidden
when a draft is already authored so choosing an example cannot replace it.
Typing that arrives while the first conversation is being created moves into
that conversation’s draft and is preserved when the earlier prompt is sent. Reopening a
conversation after a window reload restores its acknowledged draft, even while
the runtime connection is unavailable. Each draft accepts at most 50,000
characters; the application retains at most 1,000,000 draft characters across
open conversations. A refused save remains visible as an error. Acknowledged
drafts are saved in private desktop storage; they are not model messages or
admitted CLI history. Queues, pending reviews and running activities remain
connection-local and end when the application quits; they are never replayed
from the draft store.

A draft-only conversation keeps its tab after reconnecting or restarting. Because
an unsubmitted conversation has no durable runtime history yet, the desktop
recreates its runtime slot while retaining the same conversation and draft
owner. Its first submitted message, review and answer stay in that conversation.

Rapid navigation keeps the most recently selected conversation in view. An
older history, model or output request cannot switch back to its former target
or show another conversation's background output. Reattaching a captured
history snapshot also retains newer live messages, queue changes and reviews;
already included chunks are not appended twice. Closing the app waits for the
runtime processes it owns to stop, including a connection already terminated
by a signal. A failed connection offers Reconnect; stopped work is never
silently replayed.

## Optional operator wire methods

These methods exist only under `--desktop`, and initialization advertises them.
Extensions are scoped to the child process's canonical project. They are not core
ACP methods and are not automatically installed in embedded SDK servers.

| Method | Arguments | Result |
| --- | --- | --- |
| `namzu/project/status` | none | canonical cwd and remembered trust |
| `namzu/project/trust` | exact `cwd`, `confirmed: true` | updated trust; client must require an operator confirmation |
| `namzu/project/untrust` | exact `cwd`, `confirmed: true` | `{cwd, removed, trusted, stillTrustedBy?}`; removes only the trust entry that names exactly this folder. `trusted` stays `true` with `stillTrustedBy` set when an ancestor entry still covers it. Used by [Removing a project](#removing-a-project); a host that does not advertise it is simply not asked |
| `namzu/conversations/list` | none | up to 100 recent project conversations |
| `namzu/conversations/history` | `sessionId` | bounded text messages, text `partial`, and optional ordinary `work` v1 display snapshot |
| `namzu/conversations/archive` | exact `sessionId` | strict captured-project archive; `{sessionId, archived: true}` only for a confirmed archived journal, or `{sessionId, archived: false, missing: true}` for confirmed absence. A journal recorded under a different Namzu identity (regenerated `identity.json`) is refused with `This conversation was saved by a different Namzu identity.` and left untouched; the Desktop operator drops that sidebar row, and any restored or catalogue-only row the host reports missing, without archiving |
| `namzu/conversations/archived` | `{}` | the project's archived conversations, newest first, as rows shaped like `namzu/conversations/list`; empty in a Pal workspace; requires folder trust |
| `namzu/conversations/unarchive` | exact `sessionId` | restores one owned archived conversation (a single log append, no idle-writer gate) and returns its list row; rejects an unowned, unarchived or Pal conversation; requires folder trust |
| `namzu/conversations/rename` | exact `sessionId`, `title` (at most 200 characters) | `{title}`; names the conversation, and an empty title restores the title derived from its first message |
| `namzu/conversations/fork` | exact `sessionId` | `{id, title}` of a new owned copy; refused while a turn is open, for a Pal workspace, or when the conversation has no messages |
| `namzu/conversations/markdown` | exact `sessionId` | `{markdown, truncated}`; the strict transcript export, cut at 4 MiB of UTF-8 on a character boundary with `truncated: true` |
| `namzu/project/git` | `{}` | `{branch, subject}` for the host folder, or `null` when untrusted, not a repository, git is missing or slower than 3 s. `branch` is `null` on a detached HEAD, `subject` is the last commit's first line (200 characters). Runs `git -c core.fsmonitor=false --no-optional-locks` with no shell, `GIT_OPTIONAL_LOCKS=0`, a 64 KiB output cap and a 15 s cache per folder |
| `namzu/project/changes` | `{}` | `{files, truncated}` of the working tree against HEAD, or `null` when untrusted or not a repository (a timeout is an error, never an empty list). Each file is `{path, status, added, removed, oldPath?, binary?}` (a renamed binary file stays `renamed` and carries `binary: true`) with `status` one of `modified`, `added`, `deleted`, `renamed`, `untracked`, `binary`, paths relative to the host folder. At most 2,000 files, then `truncated: true` |
| `namzu/project/diff` | exact `path` | `{before, after, binary, truncated}`: the file in HEAD and in the working tree, `null` for a side that does not exist, `binary: true` for NUL bytes or invalid UTF-8, `truncated: true` over 2 MiB. Requires folder trust; the path is confined as the file panel's are |
| `namzu/conversations/input/status` | exact `sessionId`, optional `scopeId` | current or retained closed prompt scope, `available`, and input IDs classified as `pending` or `delivered` |
| `namzu/conversations/input` | exact `sessionId`, `scopeId`, `inputId`, text `prompt` | idempotent current-turn admission receipt; differing text under the same input ID is refused |
| `namzu/pals/delete` | exact `id`, `expectedRevision` | `{id, deleted: true}` after exact-revision terminal publication; retained data is not erased |
| `namzu/harnesses/release` | `engine` (`codex-cli` or `claude-code`) | `{released: true}`; ends the idle engine servers this connection keeps (the Codex app-server that discovery parked) so the engine's program can be replaced on disk, without touching a running conversation. Used by [engine updates](#updates-to-the-programs-namzu-works-with); a host that predates it answers `-32601` and the update goes on |
| `namzu/providers/status` | optional `sessionId` | safe configured provider metadata and saved default; an external engine's row also carries an optional `identity`, a short hash of the installed build, that the stored model list is keyed by |
| `namzu/providers/models` | `provider`, optional `sessionId` | configured provider catalogue; `{ models: [{ id, label, note? }], notice }`, with at most 4,096 actual listed rows; unavailable selections and failed lists have explicit notices; an external engine's reply may add `timings` (spawn, initialize and model-list milliseconds of the start it waited for) |
| `namzu/providers/select` | `sessionId`, `provider`, optional `model` | checks access and supported wire before replacing a session-local choice; active work blocks changes |
| `namzu/providers/settings` | `provider`, `model`, optional `sessionId` | exact supported effort choices/default or a safe notice, without creating a session |
| `namzu/plugins/list` | optional `sessionId` | bounded installed or live plugin inventory and whether it can be changed |
| `namzu/plugins/set_enabled` | `sessionId`, `name`, `enabled` | changes one loaded plugin in an idle conversation and returns its inventory |
| `namzu/turns/undo-status`, `namzu/turns/undo-preview`, `namzu/turns/undo` | see [Turn undo](turn-undo.md#acp-methods) | per-reply file undo, used by [Undoing a reply](#undoing-a-reply) |
| `namzu/jobs/list` | `sessionId` | this session's jobs |
| `namzu/jobs/read` | `sessionId`, `jobId` | retained chunk, offsets and dropped-byte count |
| `namzu/jobs/stop` | `sessionId`, `jobId` | stopped job |

The desktop main process wraps these for the renderer. `renameConversation`, `forkConversation` and `conversationMarkdown` need a trusted folder, a host that advertises all three methods (older hosts answer "Update Namzu…"), and an ordinary Namzu-engine conversation; Pal and external-engine conversations get a plain refusal. Rename sets the title on the host, then the in-memory view, the project catalogue and `desktop-conversations.json`, and emits `conversation-updated`. `setConversationPinned` is desktop-local: it stores `pinned: true` on the saved conversation view (the strict validator accepts only `true`, never on a Pal conversation), keeps it across catalogue refreshes and emits `conversation-updated`. `forkConversation` refuses a conversation that is running, queued, awaiting review or never prompted, registers the copy in the same project with the source's draft settings and model choice (its history loads when it is first opened) and returns its view. `projectGit` returns `null` for an untrusted folder, a Pal workspace, an older host or any host error. The window-owner checks match the other session-scoped handlers: the calling window must own the conversation.

### Host terminals

`namzu acp --desktop` owns pseudo-terminals for the Desktop: the CLI host process, not the Electron main process, so a terminal is started, killed and cleaned up where the session lifecycle already lives, and the SDK stays free of native code. The Desktop is a view of them. The ten methods and two notifications below are advertised at initialization (`RuntimeClient.supportsTerminals()` is true only when the host answers all ten); a host that predates them answers `-32601`. Terminals are scoped to the connection's project folder: a terminal starts in the project folder or below it, and every one is ended when the connection closes.

| Method | Arguments | Result |
| --- | --- | --- |
| `namzu/terminal/status` | none | `{available, reason?, platform, limits}`; `available: false` carries why (the binding is not installed, or fails to load) |
| `namzu/terminal/create` | `cols`, `rows`, optional `cwd`, `command`, `args`, `env`, `title` | `{terminal}`. No `command` runs `$SHELL` (`ComSpec` on Windows). `env` maps a name to a value, or to `null` to remove it from the host's environment; `ELECTRON_RUN_AS_NODE` is removed unless asked for, so a shell does not turn Electron programs into plain interpreters. At most 16 terminals; ended ones make room |
| `namzu/terminal/list` | `{}` | `{terminals}` with id, pid, title, cwd, command, args, size, `status` (`running` or `exited`), `exitCode`, `signal`, `offset` and `writerHeld` |
| `namzu/terminal/attach` | `terminalId`, `viewerId`, optional `fromOffset`, `writer`, `force` | `{terminal, mode, screen, data, start, end, writer, truncated}`. `replay` mode: the view keeps what it drew and appends `data`, which starts at its own `fromOffset`. `snapshot` mode (no offset, or an offset older than the ring): the view resets, writes `screen` (serialized by a headless emulator, at most 1,000 scrollback rows and 2 MiB) and then `data`. Live notifications continue at `end` |
| `namzu/terminal/detach` | `terminalId`, `viewerId` | `{}` |
| `namzu/terminal/write` | `terminalId`, `viewerId`, `data` (at most 65,536 characters) | `{written}`; only the view holding the keyboard may write |
| `namzu/terminal/resize` | `terminalId`, `viewerId`, `cols` (1 to 500), `rows` (1 to 200) | `{}`; keyboard holder only; the program and the host's screen are resized together |
| `namzu/terminal/ack` | `terminalId`, `offset` | `{}`; output delivered so far |
| `namzu/terminal/kill` | `terminalId` | `{}` once the whole process tree has ended; the terminal stays listed, ended, with its last screen |
| `namzu/terminal/close` | `terminalId` | `{}`; ends it if running and forgets it |

Output is announced as `namzu/terminal/data` (`{terminalId, offset, data}`, at most 16,384 characters, never splitting a surrogate pair) and `namzu/terminal/exit` (`{terminalId, exitCode, signal?}`, after the last output). Offsets count UTF-16 code units of everything the program printed and only grow, which is how the Desktop's `TerminalHostClient` (`src/main/terminal-client.ts`) drops a chunk it has, cuts an overlap, and reports a **gap** so its owner re-attaches from the offset it has. Chunks are coalesced per event-loop turn, and nothing is announced while no view is attached. The host keeps the last 1 MiB of output per terminal for replay.

One view holds the keyboard at a time. `attach` with `writer: true` takes it when it is free; a second claimant is refused (`Another view is typing in this terminal.`) unless it passes `force: true`. Flow control keeps a fast program from outrunning a slow view: with a view attached, the program is paused when more than 512 KiB is announced and not acknowledged, and resumed below 128 KiB, or when the last view detaches. The Desktop acknowledges in 64 KiB batches.

**Killing a terminal ends its whole process tree.** On Linux and macOS the program leads its own session, so its process group is signalled (hang-up, then kill after a grace). A program that detached itself (`nohup`, `setsid`) is no longer in that group, so the host lists the program's descendants first (`/proc` on Linux, `ps` elsewhere) and kills those still running once the terminal has ended. A terminal's folder is checked after links are resolved, so a link inside the project that leads out of it is refused. On Windows the console session's process list is ended through the binding, with `taskkill /T /F` as the forced step. The binding's Windows kill path forks a helper that prints `AttachConsole failed` to the inherited standard error whenever the session is already gone; the host re-forks that one helper with a piped standard error, so the line never reaches the Desktop's diagnostic channel.

**Starting the bundled CLI in a terminal on Windows.** The Electron executable is a Windows-subsystem program, and on a pseudo-console it behaves differently from `node.exe`: started directly as the terminal's program (`command` = the executable, `ELECTRON_RUN_AS_NODE=1`) it exits 0 and prints nothing; started through `cmd.exe` (`command: "cmd.exe"`, `args: ["/d", "/c", <executable>, <script>, …]`, no nested quoting) it prints, `process.stdout.isTTY` is true, but `process.stdin` is not the console, so the interactive screen could not read a key. The interactive screen therefore opens the console input device (`\\.\CONIN$`) as its input when, and only when, it runs on Windows with a terminal for output and none for input (`src/tui/console-input.ts`); every other launch keeps `process.stdin`. Measured on Windows 10 with Electron 44.5.1 against the staged CLI runtime: a terminal started as `cmd.exe /d /c electron.exe tui-entry.mjs --provider … --model … --effort high --permission-mode plan` showed the chosen model, `Plan (read-only)` and the effort notice, and accepted typed keys through `namzu/terminal/write`. Turkish text round-trips through `cmd.exe` after `chcp 65001` (`ğüşöçı İ` echoed intact); Windows PowerShell 5.1 drops a typed `İ`, so the default shell is `pwsh.exe` when installed, else `cmd.exe` with `chcp 65001`.

`node-pty@1.1.0` (N-API, no rebuild for Electron) is an **optional** dependency of `@namzu/cli`. It ships Windows and macOS binaries and compiles on Linux at install time; if that fails, everything else works and `namzu/terminal/status` reports `available: false`. Requests are validated on the host (`packages/cli/src/terminal/protocol.ts`: closed shapes, bounded sizes, a `__proto__` environment name is data) and every answer and notification is validated again by the Desktop (`src/shared/terminal-protocol.ts`); a test fails when the two files' method names or limits drift. The host's terminal command and the Desktop's Namzu engine terminals share one recipe: the bundled CLI is the program (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`), with the [launch flags](launch-flags.md) for the composer's choices.

### Working-tree changes

`namzu/project/changes` and `namzu/project/diff` back the Changes view's "Uncommitted changes" scope. They run only in a trusted folder and read, never write. Git runs with no shell as `git -c core.fsmonitor=false --no-optional-locks` and `GIT_OPTIONAL_LOCKS=0`, a 10 s timeout and a 1 MiB output cap per call, with `--no-ext-diff --no-textconv`, so repository configuration cannot run a program. The list comes from `diff --numstat -z --find-renames HEAD` (binary files are `-\t-`) and `diff --name-status` for the status letters, with `--relative` so paths are relative to the host folder and changes outside it are left out. In a repository with no commit yet it compares against git's empty tree. Untracked files come from `ls-files --others --exclude-standard -z`: the first 200 are read and counted as added lines (text only, at most 2 MiB each, never through a link); the rest are listed as new with no count.

`namzu/project/diff` validates the path as text first (no absolute path, drive letter, backslash on Windows, control character, `..` or `.git` segment), then resolves links and requires the real file to be inside the folder and not under `.git`, a regular file and at most 2 MiB. The "before" side is `git cat-file blob HEAD:./<path>`, which refuses a directory (a renamed file is read from its old path); the "after" side is the working file, absent for a deleted one. Either side being binary or over the cap returns no text for both. Desktop's `projectChanges` and `projectDiff` need a trusted, ordinary project and a host advertising both methods, check every field of the answer, and return `null` (changes) or refuse with a plain sentence (diff) otherwise.

The additive ordinary history `work` snapshot has `v: 1`, a receipt-completeness
`partial` flag, and arrays `messages`, `turns`, and `tools`. Message anchors carry
the retained row index, actual message/turn IDs and journal order. Turns carry
the actual user-message identity, terminal classification and optional recorded
runtime duration. At most 100 selected tool receipts carry actual turn/call IDs,
latest-attempt order, name, outcome and an optional recorded public presentation.
Each presentation is cloned from known fields and bounded to 32 KiB, with a
128 KiB aggregate view limit. Text bounds remain unchanged. Missing legacy or
oversized details are explicit; raw inputs, structured spills and opaque
reasoning are excluded. The same strict owned snapshot supplies messages and
receipts; folded replacements and compaction determine which identities survive.
An unfinished historical action is Interrupted, never a restored running action
or approval. Pal friend-chat filtering and its history wire remain unchanged.

The native main process owns these methods. Its preload exposes only named UI
actions, and checks the requesting registered window, exact web contents,
main frame and renderer URL. Node integration is disabled, context isolation
and renderer sandboxing are enabled. Arbitrary renderer navigation,
`window.open` and webview attachment remain blocked. Detachable workspace
windows are created and registered explicitly by main under the same policy.
The built UI has a restrictive
content policy. Model and tool text is rendered as text, never executable HTML.

## Current scope

The preview covers local projects, conversation history, tab groups, split panes,
detachable native windows, formatted replies,
tool review, model settings, attachments, plugin inventory, message queues,
background shells and persistent Pals with local virtual computers. Each computer
runs its installed browser, terminal and Files applications; its live desktop
supports exclusive operator control. Remote hosts, native release packaging and
auto-update are not offered in this preview. Source comparisons and validation
receipts are in `research/runtime-desktop-20260930/`.
