---
type: Reference
title: The native Windows helper
description: namzu-win, the compiled helper that replaces the PowerShell scripts behind Windows computer use; its namzu-win/1 line protocol, the read side (windows, displays, snapshot, identity, resolve, seq, wait_change), refs, element fingerprints, key names, DPI math, the TypeScript backend, conformance vectors and the CI jobs that build and test it.
resource: crates/namzu-win-core/src/protocol.rs
tags: [sdk, computer-use, windows, rust, protocol]
status: draft
generated: { by: human:bahadirarda, at: 2026-11-24T00:00:00Z }
---

# The native Windows helper

Windows computer use used to run on PowerShell scripts that compile C# at run
time, hide their window, pass their code with `-EncodedCommand` and install
global input hooks. That is the shape antivirus products flag, and a person
cannot read what runs. `namzu-win` replaces those scripts with one compiled
program that calls the Windows APIs directly (UI Automation, window event
hooks, Windows.Graphics.Capture, `SendInput`) and speaks a small JSON-lines
protocol on stdio, where the scripts speak theirs today.

The helper is being built in steps. This page describes what exists, and says
which parts do not yet.

| Step | State |
|---|---|
| Cargo workspace, the protocol codec, refs, fingerprints, key names, DPI math, the conformance vectors, CI on Linux and Windows | built |
| The Windows read side: windows, displays, snapshot, identity, resolve, seq, wait_change | built; written without a compiler for Windows on the machine it was written on, so the first Windows CI run is its first build |
| `NativeWinProcess` and `NativeA11yBackend` in `@namzu/computer-use`, chosen by `NAMZU_WIN_HELPER` | built, opt-in |
| Acting and input, capture, foreground lease | not yet |
| Monitor and presence overlay | not yet |
| Delivery (pinned download, bundling, signing) | not yet; CI uploads unsigned builds, and a person points `NAMZU_WIN_HELPER` at one |
| An embedded manifest (per-monitor DPI, `asInvoker`) and version resource | not yet; the helper sets per-monitor v2 awareness itself when it starts |

With `NAMZU_WIN_HELPER` unset nothing starts the helper, so no behaviour
changes for a user. Set to the path of `namzu-win.exe` on Windows (or under
WSL), `createWindowsA11yHost` returns the native backend instead of the
PowerShell host, and no PowerShell is started for the accessibility reads.

## Layout

| Path | What it is |
|---|---|
| `Cargo.toml`, `rust-toolchain.toml` | The Rust workspace at the repository root (the pnpm workspace does not see it). `rust-toolchain.toml` says `stable` with `rustfmt` and `clippy`; `rust-version` in `Cargo.toml` is the oldest compiler the code is written for. |
| `crates/namzu-win-core` | Pure Rust that builds and tests on every platform: the codec, the ref table, fingerprints, key names, DPI math, window ids, the walk that turns controls into a snapshot (`tree`) and the wait logic (`events`). |
| `crates/namzu-win` | The executable. Its loop, the `Backend` and `Responder` that let a slow op answer later, and the executor with its watchdog (`exec`) are platform independent. `src/win/` holds the Windows calls and compiles only on Windows. |
| `conformance/namzu-win/*.json` | The vectors both the Rust and the TypeScript side are held to. |
| `packages/computer-use/src/native/protocol.ts` | The TypeScript codec: `encodeRequest`, `decodeReply`, `formatRef`, `parseRef`, `nameHash`. |
| `packages/computer-use/src/native/process.ts` | `NativeWinProcess`: starts the executable (no shell, no window), greets it, matches replies to requests by id, cancels at the helper on a timeout or an abort, starts it again (up to three times) when it ends. |
| `packages/computer-use/src/native/a11y.ts` | `NativeA11yBackend`: the `AccessibilityBackend` interface answered by the helper. |

## The protocol: `namzu-win/1`

One JSON object per line, UTF-8, `\n`. The caller writes requests on stdin; the
helper writes replies on stdout. Standard error is free text for a person and
is never parsed. The helper ends when stdin closes or on `quit`.

A request is `{"id":N,"op":"...", ...fields}`. A reply is
`{"id":N,"ok":true, ...fields}`, or `{"id":N,"ok":false,"code":"...","message":"..."}`.
An `id` is a non-negative integer no larger than 2^53 - 1, so a JavaScript
caller never rounds one. A reader ignores a field it does not know, which is
how a newer helper adds one. A line that never named an id is answered with id
0.

```json
{"id":1,"op":"hello","protocol":"namzu-win/1","cliVersion":"55.0.0"}
{"id":1,"ok":true,"version":"0.1.0","buildHash":"dev","arch":"x86_64","osBuild":"unknown","caps":[],"dpiAwareness":"unknown"}
```

Field names are camelCase and rectangles are virtual-desktop physical pixels,
the same shapes as the accessibility interfaces in
`packages/computer-use/src/a11y/interface.ts`.

| `op` | Request fields | Reply |
|---|---|---|
| `hello` | `protocol`, `cliVersion` | `version`, `buildHash`, `arch`, `osBuild`, `signer?`, `caps`, `dpiAwareness`. A `protocol` other than `namzu-win/1` is refused with `protocol_mismatch`. |
| `windows` | `includeOwned?` | `windows`: id, process id and name, title, bounds, minimized, focused, z. |
| `displays` | | `displays`: id, bounds, work area, `scale`, primary. |
| `snapshot` | `windowId`, `maxNodes?` (400), `maxDepth?` (12), `skeleton?`, `allowChromium?`, `timeoutMs?` (8000) | `revision`, `nodes` (each with its `ref`), `total`, `truncated`, `skeleton`, `readMs`. |
| `identity` | `windowId`, `index`, `revision?` | `fingerprint` of control `index` of the window's latest read. `stale_snapshot` when `revision` is not the latest. |
| `resolve` | `windowId`, `fingerprint` | `found: true` with `index`, `via` (`runtimeId`, `automationId` or `name`) and `revision`, or `found: false` with `code` (`not_found` or `ambiguous`) and `candidates?`. |
| `seq` | `windowId?` | `seq`. With a window it also starts watching it. |
| `wait_change` | `windowId`, `since?`, `quietMs?` (120), `timeoutMs?` (2000, at most 10000), `kinds?` (`structure`, `property`, `location`) | `changed: true` with `settled`, `firstEventMs`, `settledMs`, `events`, `newWindows`; or `changed: false`, `timedOut: true`, `settledMs`. |
| `cancel` | `target` (the id of the request to stop) | `ok`. |
| `quit` | | `ok`, then the helper ends. |

The failure codes are `bad_request`, `unknown_op`, `protocol_mismatch`,
`stale_snapshot`, `chromium_not_activated`, `not_found`, `ambiguous`,
`background_unavailable`, `elevated_target`, `timeout`, `unsupported`,
`cancelled` and `internal`. A reader keeps a code it does not know as text.

A window id is `w:<handle as 16 hex digits>:<process id>`, as `windows` lists it.
The process id is there because a handle can be reused by another window after
the first closed; an id whose process no longer owns the handle is `not_found`.
A caller that only knows the handle may write `w:<handle>`, and the helper then
skips that check. The TypeScript backend hands its callers the `0x<handle>` form
the adapter has always used and translates both ways.

A build without the Windows calls (any other platform) answers the ops beyond
`hello`, `cancel` and `quit` with `unsupported` and a message naming the op, and
`hello` reports `caps` as an empty list, so a caller can tell a build apart from
a finished one. The Windows build reports `windows`, `displays`, `snapshot`,
`identity`, `resolve`, `seq`, `wait_change`, `uia` and `hooks`, its OS build
number and `dpiAwareness: "perMonitorV2"`.

## The Windows read side

Replies are the shapes the PowerShell accessibility host gave, so a caller
swaps the process and nothing else.

- `windows` lists the visible, un-cloaked, non-tool top-level windows, without
  an owner unless asked, front to back, with the visible frame as `bounds` (the
  normal position for a minimized window). It makes no accessibility call.
- `displays` lists the monitors with their work area and `scale` from the
  monitor's effective dpi. The `id` is the device name.
- `snapshot` asks UI Automation for the window's controls with one cache request
  that carries every property the reply lists, then reads them from the cache.
  Which controls (the ones a person sees), how many (`maxNodes`, `maxDepth`),
  what `childCount` means and how a `skeleton` differs are decided by
  `namzu-win-core`'s `tree` module, tested against an in-memory tree on every
  platform. A Chromium, Electron or Firefox window is refused with
  `chromium_not_activated` unless `allowChromium` is set, because reading one
  switches its accessibility on for the rest of the session. A password's value
  is never read.
- `identity` and `resolve` use the fingerprints below. `resolve` reads the
  window again, so its answer names an index in what is now the latest read.
- `seq` returns the number of the last change seen. Given a window it first
  starts watching it: UI Automation structure and property handlers on the
  window (not for a Chromium window) and a window-event hook scoped to its
  process. At most 32 windows are watched; the least recently used is let go.
- `wait_change` settles from events, never from sleeping: after at least one
  change that concerns the window and then `quietMs` without another, or at
  `timeoutMs`. Callbacks only record an event and return; one scheduler thread
  settles waits, waking when an event arrives or the earliest wait is due. A
  `since` marker counts changes made before the wait began. A new top-level
  window of the same program counts, and is reported in `newWindows`.
  The counting is `namzu-win-core`'s `events` module, driven by a clock that is a
  number, so it is tested without waiting.

UI Automation calls run one at a time on a single thread in the multithreaded
apartment. A call that does not return by its deadline is answered `timeout`, the
thread stuck in it is left to end by itself, and a new thread takes over the
queue, so one program that hangs does not hang the next question. `cancel`
answers a waiting op `cancelled` at once.

## Refs

A snapshot names every control `r<revision>.<index>`: the read it came from
and its position in `nodes`. Both numbers are plain decimal with no sign, no
leading zeros and no spaces, so one control has one spelling; a revision is at
most 2^53 - 1 and an index at most 2^32 - 1.

The helper keeps what it needs to act on a control (the live UI Automation
element) for a window's current read and the one before it. A ref from the
current or previous read resolves; an older one is `stale_snapshot`, one from a
read that was never made is refused, and one past the read's controls is out of
range. A window that closed is forgotten.

## Fingerprints

A fingerprint names a control well enough to find it again after the window
changed, and holds no text: the platform's runtime id, the automation id, the
kind (role), a hash of the name, the path of the ancestors, the position among
siblings with the same kind and name, and when the owning process started.

- The name hash is FNV-1a (32 bit) over the **UTF-16 code units** of the name, as
  eight lowercase hex digits. UTF-16 so a fingerprint taken by the PowerShell
  scripts, which hashed a .NET string, resolves in the helper and back.
- A control's tag is its kind, a colon and its name hash. Its parent path is its
  parent's tag, or its parent's path, a slash and its parent's tag. A window has
  the empty path.
- `resolve` tries the runtime id; then the automation id with the same kind,
  narrowed by path and then by position; then kind, name hash and path, narrowed
  by position. A narrowing that would leave nothing is skipped. Two or more
  survivors are `ambiguous`. A process that started at another time than the
  fingerprint says is a different run, and nothing resolves.

## Key names

`ctrl+shift+t`, `alt+F4`, `page_down`: modifiers, then the key, joined by `+`; a
trailing `+` is the plus key. The spellings are the ones the PowerShell adapter
accepts. `ctrl`, `control`, `cmd`, `command` and `meta` are Control (the
shortcut key on Windows); `alt`, `option` and `opt` are Alt; `win`, `windows`
and `super` are the Windows key. Named keys are Enter/Return, Escape/Esc, Tab,
Backspace, Delete, Insert, Space, the arrows, Home, End, Page_Up, Page_Down and
F1 to F24. A letter or digit is its virtual-key code; any other character is
left to the keyboard layout on the Windows side.

## Pixels

The helper runs per-monitor DPI aware, so every coordinate it reports is a
physical pixel of the virtual desktop, the space UI Automation, capture and
`SendInput` agree on. A scale is the monitor's dpi over 96. A caller that
thinks in a monitor's scaled pixels converts with that monitor's own scale. A
point just outside the desktop is scaled by the nearest monitor. `SendInput`'s
absolute space is 0 to 65535 across the whole virtual desktop, clamped to it.

## Conformance vectors

`conformance/namzu-win/` holds `protocol.json`, `refs.json`, `fingerprint.json`,
`keys.json` and `dpi.json`. Unlike the SDK's vector sets they are written by
hand, because the Rust crate is the reference for this protocol; the point of
the files is that two implementations are held to the same lines.

| File | Held by |
|---|---|
| `protocol.json` | Rust (`tests/conformance.rs`) and TypeScript (`native-protocol.test.ts`): valid requests and replies, lines that must be refused |
| `refs.json` | both: the one spelling of a ref |
| `fingerprint.json` | Rust: assignment and resolution; both: the name hash |
| `keys.json`, `dpi.json` | Rust |

A change to the wire format changes the vectors in the same commit, and a
reader that fails after it is told what changed by the diff.

## Running it

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
pnpm --filter @namzu/computer-use test -- native
```

CI runs the first three in the `Rust (Linux)` job, and builds
`x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc` in the
`Windows helper` job on a Windows runner, running the x64 build's own tests
there: the stdio test, and `tests/windows_uia.rs`, which starts the helper as a
program, creates a window of its own with a button, and checks the helper lists
it, reads its controls, names and finds the button again, sees a change the test
makes, and cancels a wait. The executables are uploaded as run artifacts with a SHA-256, unsigned.
Nothing in CI or in this repository runs the helper on a person's machine.
The release build sets `NAMZU_WIN_BUILD_HASH`, which `hello` reports as
`buildHash`; a local build reports `dev`.
