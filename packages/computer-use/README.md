<!-- okf
type: Reference
title: "@namzu/computer-use"
description: >-
  Screen capture, keyboard and pointer control behind one adapter interface.
  Which backend serves a call depends on the platform, and what a platform
  cannot do is reported as a capability rather than discovered as a failure.
tags: [readme, package, computer-use, adapters]
status: stable
generated: { by: human:bahadirarda, at: 2026-08-20T00:00:00Z }
-->

<div align="center">

<h1>@namzu/computer-use</h1>

**Screen, keyboard and pointer control for Namzu agents.**

[![npm](https://img.shields.io/npm/v/@namzu/computer-use.svg)](https://www.npmjs.com/package/@namzu/computer-use)
[![build](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)

[Install](#install) · [Usage](#usage) · [Documentation](#documentation)

</div>

---

Screen capture, keyboard and pointer control, behind one adapter interface.
Which backend serves a call depends on the platform, and what a platform
cannot do is reported as a capability rather than discovered as a failure.

Adapters publish an exact `supportedActions` subset. Optional `mouseClickButtons`
and `mouseDragButtons` distinguish gesture support: on macOS scrolling is
unavailable, move/drag require cliclick, and drag supports only the left button.
The SDK tool filters its advertised actions and rejects unsupported gestures
before desktop execution. See [the computer_use tool](../../docs/sdk/computer-actions.md)
and [the host contract](../../docs/sdk/computer-use-host.md).

## Install

```bash
pnpm add @namzu/sdk @namzu/computer-use
```

`@namzu/sdk` is a peer dependency. Install both.

## Usage

```ts
import {
  SubprocessComputerUseHost,
  type SubprocessComputerUseHostOptions,
} from '@namzu/computer-use'
import { createComputerUseTool, toolset } from '@namzu/sdk'

const options: SubprocessComputerUseHostOptions = {
  env: process.env,
  platform: process.platform,
}
const host = new SubprocessComputerUseHost(options)
await host.initialize()

console.log(host.capabilities)
// {
//   displayServer: 'darwin',
//   screenshot: true,
//   mouse: true,
//   keyboard: true,
//   cursorPosition: false,  // unless `cliclick` is installed
//   clipboard: true,
// }

const tools = toolset('computer-use', [createComputerUseTool(host)])
```

If a click, drag, scroll, text entry or key subprocess starts but does not
report a clean completion, the host throws
`ComputerUseOutcomeUnknownError`. The desktop may already have changed; the
SDK returns that state to the model with `retrySafety: 'unsafe'` instead of
inviting an automatic replay.

Every coordinate and size crossing the host is in **physical pixels**: the
pixels of the captured bitmap, never points or DPI-scaled units. A capture
carries `display` (origin, size, `scaleFactor`) and action points are
relative to that display. On a Retina Mac the adapter converts to points for
`cliclick` itself, so a click at the pixel you saw lands there; on Windows
every backend is DPI aware.

`host.dispose()` stops whatever the adapter keeps running. Call it when the
session ends.

## Windows and WSL

When Namzu runs inside WSL, the host selects the paired Windows desktop. This
takes precedence over WSLg's `DISPLAY`/`WAYLAND_DISPLAY`, which describe Linux
GUI applications rather than the Windows desktop containing the terminal.

The desktop is driven by [cua-driver](https://github.com/trycua/cua) (MIT),
one `cua-driver.exe mcp` process for the host's lifetime, spoken to over its
standard streams:

- **Pinned and checked.** The first `initialize()` downloads cua-driver
  0.28.2 for this architecture (x64 or arm64, a 27–29 MB archive from the
  project's GitHub releases), checks the SHA-256 of the archive and of the
  executable in it against values in this package, and keeps
  `cua-driver.exe` in `<NAMZU_HOME>/computer-use/cua-driver/0.28.2/`
  (`~/.namzu` by default). Nothing else in the archive is written. Later
  sessions start the cached copy after checking its hash again.
- **Quiet.** It runs with its telemetry and its release check switched off
  (`CUA_DRIVER_RS_TELEMETRY_ENABLED=0`, `CUA_DRIVER_RS_UPDATE_CHECK=0`,
  forwarded through `WSLENV`), without any environment variable whose name
  looks like a secret, and with its animated agent cursor off. Measured: a
  whole session left nothing in the Windows user profile.
- **Idle recovery.** cua-driver ends its implicit desktop session after five
  minutes without a completed call, even while its MCP process stays running.
  When it explicitly refuses the next call with its structured `session_ended`
  code before dispatch, the adapter revives that session, switches the agent
  cursor off again, and retries the refused call once. An expired UI Automation
  snapshot must be taken again before acting on a control. The adapter gives
  every snapshot fresh refs and rejects old refs after a driver restart, even
  if the driver reuses a raw element token. A lost response or driver crash
  still leaves a changing action's outcome unknown and is never replayed
  automatically.
- **Windows.** `capabilities.windows` is `true`: `listWindows()` and
  `focusWindow(id)` (which restores a minimized window, gets past the
  foreground lock and reports what is actually in front afterwards).
- **Controls (experimental).** `capabilities.uiTree` is `true`:
  `uiSnapshot(windowId?)` reads a window's UI Automation tree (the window in
  front without an id) and `uiAct(ref, action, value?)` acts on a control of
  the latest snapshot — `invoke`, `toggle`, `select`, `expand`, `collapse`
  through UI Automation in the background, `set_value` through the control's
  value, or by typing into an empty field that has none. The SDK tool offers
  these as `ui_snapshot` and `ui_act`. Pressing six Calculator buttons this
  way took about 90 ms, without bringing the window to the front.
- **Fallback.** When cua-driver cannot be downloaded, verified or started,
  or does not reach the desktop, the host uses PowerShell instead — one
  `powershell.exe` per action, DPI aware, Unicode text, no window list.
  `host.backend` says which is in use (`cua-driver 0.28.2`, `powershell`),
  `host.fallbackReason` why cua-driver is not.

`NAMZU_CUA_DRIVER=off` keeps cua-driver out (no download); a path in it runs
that `cua-driver.exe` instead of the pinned build. The same choices in code:

```ts
import { SubprocessComputerUseHost } from '@namzu/computer-use'

const host = new SubprocessComputerUseHost({
  windows: {
    backend: 'auto', // or 'cua-driver' (no fallback) or 'powershell'
    download: true, // false: use a cached or configured build only
  },
})
await host.initialize()
console.log(host.backend, host.fallbackReason)
if (host.capabilities.windows) {
  const windows = await host.listWindows()
  const notepad = windows.find((window) => window.app === 'notepad')
  if (notepad) await host.focusWindow(notepad.id)
}
await host.dispose()
```

Measured on Windows 10 22H2 from WSL2, one 3440x1440 display at 100 %:

| Call | PowerShell per action (before) | cua-driver |
| --- | --- | --- |
| `initialize()` | 0.3 s | 0.5–0.7 s (2.2 s the first time, with the download) |
| screenshot (3440x1440 PNG) | 0.40–0.42 s | 0.08–0.13 s |
| cursor position | 0.31 s | 1–6 ms |
| move | 0.54–0.60 s | 1–5 ms |
| click | 0.68–0.83 s | 0.13–0.14 s |
| key | not measured | 0.04–0.05 s |
| type 21 characters | not measured | 0.09 s |
| focus a window | not offered | 4–22 ms |
| list windows | not offered | 1.2–1.9 s |

What cua-driver does not do, and so neither does this host on Windows: it
captures the primary display only; it has no region capture (the SDK crops a
full capture instead); its window list includes windows Windows keeps
cloaked (a suspended Settings app, the text-input host), and it does not say
which window has focus — `focused` is the front-most window that is not
minimized. A single punctuation key (`/`, `+`) is typed as text, because
cua-driver resolves it to a key without its shift state and on a Turkish
layout `/` came out as `7`; a chord such as `ctrl+/` still goes through
cua-driver's key mapping.

## Documentation

- [Namzu docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
