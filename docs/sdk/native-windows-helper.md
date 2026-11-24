---
type: Reference
title: The native Windows helper
description: namzu-win, the compiled helper that replaces the PowerShell scripts behind Windows computer use; its namzu-win/1 line protocol, the read side (windows, displays, snapshot, identity, resolve, seq, wait_change), acting by pattern, input, capture, the foreground and its lease, refs, element fingerprints, key names, DPI math, the TypeScript backend and display adapter, conformance vectors and the CI jobs that build and test it.
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
| Acting by pattern (`act`), input (`input`), capture (`capture`), the foreground (`foreground.get`, `foreground.set`) and its lease (`lease.begin`, `lease.end`) | built; written without a compiler for Windows on the machine it was written on, so the first Windows CI run is its first build; `windows_act.rs` drives every op against a window the test makes |
| `NativeWin32Adapter` (screenshot, zoom region, click, drag, scroll, type, key, cursor, displays) in `@namzu/computer-use`, chosen by `NAMZU_WIN_HELPER` | built, opt-in |
| Monitor (raw input, no low-level hooks) and presence overlay | not yet; the foreground ladder still watches the desktop with its PowerShell monitor |
| Delivery (pinned download, bundling, signing) | not yet; CI uploads unsigned builds, and a person points `NAMZU_WIN_HELPER` at one |
| An embedded manifest (per-monitor DPI, `asInvoker`) and version resource | not yet; the helper sets per-monitor v2 awareness itself when it starts |

With `NAMZU_WIN_HELPER` unset nothing starts the helper, so no behaviour
changes for a user. Set to the path of `namzu-win.exe` on Windows (or under
WSL), `createWindowsA11yHost` returns the native backend instead of the
PowerShell host, and no PowerShell is started for the accessibility reads; and
`Win32Adapter` uses `NativeWin32Adapter` where it used the per-action
PowerShell path (cua-driver, when it is available and not turned off, is still
tried first). With a helper named there is no PowerShell fallback: a helper that
does not start is an error that names the helper, not a reason to run scripts.
Each of the two starts its own helper process.

## Layout

| Path | What it is |
|---|---|
| `Cargo.toml`, `rust-toolchain.toml` | The Rust workspace at the repository root (the pnpm workspace does not see it). `rust-toolchain.toml` pins the exact toolchain `1.99.1` (CI installs the same one) with `rustfmt` and `clippy`; `rust-version` in `Cargo.toml` is the oldest compiler the code is written for. |
| `crates/namzu-win-core` | Pure Rust that builds and tests on every platform: the codec, the ref table, fingerprints, key names, DPI math, window ids, the walk that turns controls into a snapshot (`tree`) and the wait logic (`events`). |
| `crates/namzu-win` | The executable. Its loop, the `Backend` and `Responder` that let a slow op answer later, and the executor with its watchdog (`exec`) are platform independent. `src/win/` holds the Windows calls and compiles only on Windows. |
| `conformance/namzu-win/*.json` | The vectors both the Rust and the TypeScript side are held to. |
| `packages/computer-use/src/native/protocol.ts` | The TypeScript codec: `encodeRequest`, `decodeReply`, `formatRef`, `parseRef`, `nameHash`. |
| `packages/computer-use/src/native/process.ts` | `NativeWinProcess`: starts the executable (no shell, no window), greets it, matches replies to requests by id, cancels at the helper on a timeout or an abort, starts it again (up to three times, counted afresh after a run of a minute or more) when it ends. The shipped helper aborts on a panic, so a panic ends it and this restart is the recovery. |
| `packages/computer-use/src/native/a11y.ts` | `NativeA11yBackend`: the `AccessibilityBackend` interface answered by the helper, and `act` (a control by ref or fingerprint, through its pattern); `actFailureCode` names the two failures a ref can have (`STALE_REF`, `AMBIGUOUS_TARGET`). |
| `packages/computer-use/src/adapters/win32-native.ts` | `NativeWin32Adapter`: the display `Adapter` (screenshot, zoom region, click, drag, scroll, type, key, cursor position, display geometry) on top of `input`, `capture`, `displays` and `foreground.get`. |

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
| `act` | `windowId`; `ref` or `fingerprint`; `action` (`invoke`, `setValue`, `toggle`, `expand`, `collapse`, `select`, `scrollIntoView`, `scroll`, `focus`); `text?` for `setValue`; `dx?`, `dy?` for `scroll`; `timeoutMs?` (8000) | `done`, `via: "pattern"`, `verified?`, `after?` (what the control reads as now: `value`, `toggle`, `expand`, `selected`, `focused`), and the control's `index` and `revision`. See [Acting](#acting). |
| `input` | `kind` and its fields; see [Input](#input) | `delivered` (input events the system took), `via: "sendinput"`, `cursor?`. |
| `capture` | `target` (`window`, `display` or `region`), `into?` (a directory) or `inline?`, `cursor?`, `timeoutMs?` (8000) | `path?` or `dataBase64?`, `bytes`, `width`, `height`, `scale`, `via` (`wgc`, `printwindow` or `bitblt`), `sha256`, `bounds`, `display?`. See [Capture](#capture). |
| `foreground.get` | `windowId?` | The window in front, the pointer, the input desktop, this program's rights, the system's last-input tick, how long a person has been still (`userIdleMs`) and, with `windowId`, that window's program (`target`). |
| `foreground.set` | `windowId` | `raised`, `changed`, `how` (`already`, `plain`, `unlock`, `attach`, `switch` or `refused`) and, when refused, `blockedBy` (`windows` or `elevated`). |
| `lease.begin` | `windowId?`, `raise?`, `idleMs?`, `ttlMs?` (30000), `leasePath?` with `token?` | What `foreground.get` says, `refused` (a person is still using the machine: nothing was moved and no lease is held) and, with `raise`, `raised` and `raiseHow`. |
| `lease.end` | `restore`, `keepCursor?`, `release?` | `restoredForeground`, `restoredCursor`, `restoreNote?`, `inputMoved`, `frontElevated`, `released`. |
| `cancel` | `target` (the id of the request to stop) | `ok`. |
| `quit` | | `ok`, then the helper ends. |

The failure codes are `bad_request`, `unknown_op`, `protocol_mismatch`,
`stale_snapshot`, `chromium_not_activated`, `not_found`, `ambiguous`,
`background_unavailable`, `elevated_target`, `timeout`, `unsupported`,
`cancelled`, `internal`, `disabled`, `foreground_lost`, `lease_busy`,
`lease_expired` and `input_blocked`. A reader keeps a code it does not know as
text.

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
`identity`, `resolve`, `seq`, `wait_change`, `act`, `input`, `capture`,
`foreground`, `lease`, `uia`, `hooks`, `sendinput`, `wgc` and `printwindow`, its
OS build number and `dpiAwareness: "perMonitorV2"`. `NativeWin32Adapter` starts
only on a helper that reports `capture`, `input` and `foreground`.

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

## Acting

`act` does one thing to one control through the pattern the control offers:
`invoke` (Invoke), `setValue` (Value), `toggle` (Toggle), `expand` and
`collapse` (ExpandCollapse), `select` (SelectionItem), `scroll` (Scroll, one
small step at a time, right and down positive, at most 50 steps), `scrollIntoView`
(ScrollItem) and `focus` (the only action that moves the keyboard focus). Nothing
is clicked and no key is sent: a control that offers no pattern for the action is
refused with `background_unavailable`, and the caller decides whether to use the
pointer or the keyboard instead. A control that is turned off, or whose value is
read-only, is `disabled`. Both refusals, and every one below, come before
anything is sent, so the same action may be sent again.

The control is named by `ref` (from the current or the previous read; an older
one is `stale_snapshot`) or by `fingerprint`, which reads the window again and
finds the control in it. A control that is not there is `not_found` and several
that fit are `ambiguous`; the TypeScript side calls these `STALE_REF` and
`AMBIGUOUS_TARGET` (`actFailureCode`). A program with more rights than the helper
is `elevated_target`.

The reply reads the control back live, not from the snapshot's cache: `after` is
what the control says now, and `verified` says whether that shows the effect: a
toggle changed, an expand reads expanded, a collapse reads collapsed, a selection
reads selected, a value reads as the text sent. `verified` is absent for an invoke
or a scroll, which leave nothing to compare, and for a password's value, which
the helper never reads. `index` and `revision` give the control's place in the
read that found it; after a fingerprint, refs of that revision name the window.
Which pattern an action needs, what a refusal is and what a read-back must show
are `namzu-win-core`'s `act` module, tested on every platform.

## Input

`input` sends pointer and keyboard input with `SendInput`, in the foreground
(there is no background delivery in the helper; a caller that wants one uses a
pattern with `act`). Points are physical pixels of the virtual desktop. `kind`:

| `kind` | Fields |
|---|---|
| `click` | `x`, `y`, `button?` (`left`, `right`, `middle`), `count?` (1 to 3) |
| `move` | `x`, `y` |
| `drag` | `x`, `y`, `toX`, `toY`, `button?`: press, twelve points along the way with a short pause after each, release |
| `scroll` | `x`, `y`, `direction` (`up`, `down`, `left`, `right`), `amount?` (wheel notches, 1 to 100) |
| `type` | `text`: Unicode key events (no clipboard, no layout), a line break is Enter (`\r\n` is one), a tab is Tab; at most 100000 characters |
| `key` | `keys`: a combination such as `ctrl+shift+t` (see Key names) |

`namzu-win-core`'s `input` module turns a request into a list of steps: where a
point lands in `SendInput`'s 0 to 65535 space across the virtual desktop, the
path of a drag, how many wheel notches a scroll is, how a text becomes key
events, which modifiers go down first and come up last. The Windows side only
carries the steps out, in batches, pausing where the plan says to. A point
outside every display is `bad_request` (it is refused, not clamped to somewhere
the caller did not ask for). When the system takes fewer events than were sent
(a secure prompt, or a program with more rights holds the input) the reply is
`input_blocked` and says how many were taken. A character the layout has no key
for inside a combination is sent as Unicode.

## Capture

`capture` takes a PNG of a `window`, a `display` (the primary one without an
`id`) or a `region` of the virtual desktop. A picture goes to a file in the
directory `into` names (a directory the caller made; the helper writes nowhere
else) and the reply carries its `path`, `bytes`, size, `sha256` and the `bounds`
it shows; with `inline: true` and no `into`, a picture of at most 256 KB comes
back as `dataBase64`.

- A window or a display is captured with Windows.Graphics.Capture, which works
  while the window is covered, draws no pointer unless `cursor` is set and asks
  for no yellow border (the border switch needs a recent Windows; elsewhere the
  system draws it). A window that is minimized, or a Windows that cannot capture
  one, is drawn with `PrintWindow` (`via: "printwindow"`); a display the capture
  API refused is copied from the screen (`via: "bitblt"`). A region is always
  copied from the screen. `cursor` is honoured by Windows.Graphics.Capture only.
- The pixels are made opaque (a window may leave alpha at zero where it drew
  none) and the PNG is written by the Windows imaging component, so the helper
  carries no encoder. The picture's size is the capture's own: no scaling.
- `scale` and `display` are those of the display the area is on (for a window,
  the one the system says it is nearest to).

## Foreground and the lease

`foreground.get` reports the desktop; `foreground.set` brings a window forward
the way the PowerShell foreground helper did, in the same order, and reports how
far it had to go: ask plainly; tap an unassigned key (which gives this program
the right to take the front) and ask again; borrow the front window's input
queue; the shell's switch call. A minimized window is restored. Windows may still
refuse; the answer is `how: "refused"` with `blockedBy`, never a loop.

A lease is the helper's side of the foreground ladder
(`packages/computer-use/src/foreground/`). The ladder keeps the policy (whether a
person must be asked, one session at a time through the lease file) and the
helper keeps the primitives. `lease.begin` records the window in front, the
pointer and the system's input tick, refuses (`refused: true`, nothing moved)
when `idleMs` is given and a person was not still that long, raises `windowId`
when asked, and holds the lease. While it is held:

- `input` is refused with `foreground_lost` unless a window of the lease
  window's program is in front (a dialog or menu of the program is fine), so a
  bug in the caller cannot type into another program, and with `lease_expired`
  after `ttlMs` (default 30000, the screen lease file's limit) without input.
  Every input that goes through refreshes it.
- `lease.begin` again is `lease_busy`, unless the lease has run out, which it
  ends first.
- `lease.end` puts back what the burst moved: the window that was in front only
  when this burst changed the front (the one it raised, or the target when the
  raise was refused and the program took the front itself) and still holds it;
  anything else in front means a person has moved on and it is left alone, with
  a `restoreNote` that says why. The pointer is put back unless `keepCursor`.
  `release: true` also deletes the lease file named at begin (`leasePath`) when
  the `token` in it is still the one given.
- When the helper ends (`quit`, or the caller closed its input) with a lease
  held, it ends it the same way and removes the lease file, so a crash does not
  leave the screen locked.

How long a person has been still (`userIdleMs`) comes from the system's last
input tick with the helper's own input left out (input that falls inside its own
sending, plus a short tail, is its own; a key or button held down is use). The
helper cannot yet tell a person's input from another program's, and cannot count
a person's input during a burst: that is what the monitor (raw input, with no
low-level hooks) adds, and until it exists the ladder keeps using its
PowerShell monitor for the counts, and the adapter calls the helper's `input`,
`capture`, `displays` and `foreground.get` only. Without a lease `input` goes at once, as the
PowerShell adapter's did.

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
point just outside the desktop is scaled by the nearest monitor, and an input
aimed outside every display is refused. `SendInput`'s absolute space is 0 to
65535 across the whole virtual desktop.

## Conformance vectors

`conformance/namzu-win/` holds `protocol.json`, `refs.json`, `fingerprint.json`,
`keys.json` and `dpi.json`. Unlike the SDK's vector sets they are written by
hand, because the Rust crate is the reference for this protocol; the point of
the files is that two implementations are held to the same lines.

| File | Held by |
|---|---|
| `protocol.json` | Rust (`tests/conformance.rs`) and TypeScript (`native-protocol.test.ts`): valid requests and replies, lines that must be refused, for every op |
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
there: the stdio test, `tests/windows_uia.rs`, which starts the helper as a
program, creates a window of its own with a button, and checks the helper lists
it, reads its controls, names and finds the button again, sees a change the test
makes, and cancels a wait, and `tests/windows_act.rs`, which makes a window with
a push button, a check box, a button that is turned off, a text box and a list,
and drives every acting op against it. Each effect is seen where it lands, in the
window's own procedure, which signals the test; the test waits for that event and
not for a time. It presses and toggles by pattern, sets and reads back a value,
scrolls a list, checks every refusal, acts by fingerprint, then sends a click, a
right and a double click, a drag, the wheel, text and key combinations with
`SendInput`, takes a lease and ends it, lets one run out, and takes pictures of
the window, the display and a region and checks them against their own PNG
header and hash. The executables are uploaded as run artifacts with a SHA-256, unsigned.
Nothing in CI or in this repository runs the helper on a person's machine.
The release build sets `NAMZU_WIN_BUILD_HASH`, which `hello` reports as
`buildHash`; a local build reports `dev`.
