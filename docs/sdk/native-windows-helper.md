---
type: Reference
title: The native Windows helper
description: namzu-win, the compiled helper that replaces the PowerShell scripts behind Windows computer use; its namzu-win/1 line protocol, refs, element fingerprints, key names, DPI math, conformance vectors and the CI jobs that build it.
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
| The Windows read side: windows, displays, snapshot, resolve, seq, wait_change | not yet; the helper answers `unsupported` |
| Acting and input, capture, foreground lease | not yet |
| Monitor and presence overlay | not yet |
| Delivery (pinned download, bundling, signing) | not yet; CI uploads unsigned builds |
| TypeScript backends that spawn it | not yet; `packages/computer-use/src/native/` has the codec only |

Nothing in a released package starts the helper yet, so no behaviour changes
for a user.

## Layout

| Path | What it is |
|---|---|
| `Cargo.toml`, `rust-toolchain.toml` | The Rust workspace at the repository root (the pnpm workspace does not see it). `rust-toolchain.toml` says `stable` with `rustfmt` and `clippy`; `rust-version` in `Cargo.toml` is the oldest compiler the code is written for. |
| `crates/namzu-win-core` | Pure Rust that builds and tests on every platform: the codec, the ref table, fingerprints, key names, DPI math. |
| `crates/namzu-win` | The executable. Its loop and dispatch are platform independent; the Windows calls arrive behind it in later steps. |
| `conformance/namzu-win/*.json` | The vectors both the Rust and the TypeScript side are held to. |
| `packages/computer-use/src/native/protocol.ts` | The TypeScript codec: `encodeRequest`, `decodeReply`, `formatRef`, `parseRef`, `nameHash`. |

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
| `resolve` | `windowId`, `fingerprint` | `found: true` with `index`, `via` (`runtimeId`, `automationId` or `name`) and `revision`, or `found: false` with `code` (`not_found` or `ambiguous`) and `candidates?`. |
| `seq` | `windowId?` | `seq`. With a window it also starts watching it. |
| `wait_change` | `windowId`, `since?`, `quietMs?` (120), `timeoutMs?` (2000, at most 10000), `kinds?` (`structure`, `property`, `location`) | `changed: true` with `settled`, `firstEventMs`, `settledMs`, `events`, `newWindows`; or `changed: false`, `timedOut: true`, `settledMs`. |
| `cancel` | `target` (the id of the request to stop) | `ok`. |
| `quit` | | `ok`, then the helper ends. |

The failure codes are `bad_request`, `unknown_op`, `protocol_mismatch`,
`stale_snapshot`, `chromium_not_activated`, `not_found`, `ambiguous`,
`background_unavailable`, `elevated_target`, `timeout`, `unsupported`,
`cancelled` and `internal`. A reader keeps a code it does not know as text.

Until an op has its implementation the helper answers it with `unsupported`
and a message naming the op, and `hello` reports `caps` as an empty list, so a
caller can tell a build apart from a finished one.

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
pnpm --filter @namzu/computer-use test -- native-protocol
```

CI runs the first three in the `Rust (Linux)` job, and builds
`x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc` in the
`Windows helper` job on a Windows runner, running the x64 build's own tests
there. The executables are uploaded as run artifacts with a SHA-256, unsigned.
Nothing in CI or in this repository runs the helper on a person's machine.
The release build sets `NAMZU_WIN_BUILD_HASH`, which `hello` reports as
`buildHash`; a local build reports `dev`.
