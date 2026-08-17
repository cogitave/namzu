<!-- okf
type: Reference
title: "@namzu/computer-use"
description: >-
  Desktop control for Namzu agents — screenshots, mouse, keyboard — driven
  through the CLIs already on the machine. No native addon, no prebuild matrix,
  and a capability set probed at startup rather than assumed.
tags: [readme, package, computer-use, desktop]
timestamp: 2026-08-17T00:00:00Z
status: active
diataxis: reference
-->

<div align="center">

<h1>@namzu/computer-use</h1>

**Desktop control for [`@namzu/sdk`](https://www.npmjs.com/package/@namzu/sdk).**

[![License: FSL-1.1-MIT](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)
[![npm](https://img.shields.io/npm/v/@namzu/computer-use.svg?label=%40namzu%2Fcomputer-use)](https://www.npmjs.com/package/@namzu/computer-use)

[Install](#install) · [Usage](#usage) · [Platform matrix](#platform-matrix) · [Capabilities](#capability-flags) · [Errors](#error-surface)

</div>

---
Subprocess-based computer-use host for [`@namzu/sdk`](https://www.npmjs.com/package/@namzu/sdk). Lets namzu agents control a desktop — screenshots, mouse, keyboard — via platform-native CLIs.

> No native addons. No Rust toolchain. No per-platform prebuild packages. No CFRunLoop pump. Just `spawn()` and the CLIs already on your OS.

## Install

```bash
pnpm add @namzu/sdk @namzu/computer-use
```

## Usage

```ts
import { SubprocessComputerUseHost } from '@namzu/computer-use'
import { createComputerUseTool, ToolRegistry } from '@namzu/sdk'

const host = new SubprocessComputerUseHost()
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

const registry = new ToolRegistry()
registry.register(createComputerUseTool(host))
```

The tool is a single `computer_use` action with a discriminated-union input:

```ts
{ type: 'screenshot' }
{ type: 'cursor_position' }
{ type: 'mouse_move';  to: { x, y } }
{ type: 'mouse_click'; at: { x, y }, button: 'left' | 'right' | 'middle' }
{ type: 'mouse_drag';  from: { x, y }, to: { x, y }, button }
{ type: 'scroll';      at: { x, y }, direction, amount }
{ type: 'type_text';   text }
{ type: 'key';         keys }     // e.g. "ctrl+c", "cmd+shift+t", "Return"
```

Screenshots return base64-encoded PNG in `ToolResult.output`. Destructive actions (click/drag/type/key/scroll) surface as `isDestructive === true` so namzu's HITL layer can gate them.

## Platform Matrix

| OS / Server | Screenshot | Mouse | Keyboard | Cursor Pos | Install |
|---|---|---|---|---|---|
| **macOS** | `screencapture` (built-in) | `osascript` click / `cliclick` for move+drag+right-click | `osascript` keystroke | via `cliclick` | `brew install cliclick` (optional, for move/drag/cursor-pos) |
| **Linux X11** | `maim` | `xdotool` | `xdotool` | `xdotool` | `apt install xdotool maim` / `dnf install …` / `pacman -S …` |
| **Linux Wayland** | `grim` (wlroots) | `ydotool` (needs uinput daemon) | `wtype` or `ydotool` | — | `apt install grim wtype ydotool` + start `ydotoold` |
| **Windows** | PowerShell `System.Drawing` | `SendInput` via inline C# | `SendKeys` | `Cursor::Position` | `pwsh` or `powershell.exe` (built-in) |

### macOS permissions (TCC)

On first use you'll be prompted for:

- **Screen Recording** — required by `screencapture` to produce images with window contents.
- **Accessibility** — required by `osascript` to send keystrokes and clicks.

Grant both to the terminal/app running your Node process. The adapter surfaces TCC-denied errors verbatim in `SpawnError.stderr`.

### macOS scroll

Scroll is not supported on macOS from built-in CLIs. Use keyboard navigation (`{ type: 'key', keys: 'page_down' }`) as a substitute, or install a future native host package.

### Linux Wayland caveats

- Only wlroots compositors (Sway, Hyprland, Wayfire) are supported for screenshot via `grim`. GNOME and KDE Wayland block compositor-level screen capture by design.
- `ydotool` requires the `ydotoold` daemon to be running with access to `/dev/uinput` (usually via the `input` group). If the daemon is not running, `mouse`/`keyboard` capabilities degrade to `false`.
- Cursor position has no standard Wayland API; capability stays `false` on this adapter.

### Windows caveats

- Input fails when the workstation is locked or on the screensaver. No way around this — Windows enforces user-session context for `SendInput`.

## Capability Flags

`host.capabilities` is frozen at `initialize()` and reflects what actually works, not what the action union permits. The tool layer rejects unsupported actions before hitting the adapter, so the model gets a clean error instead of a hang.

If the user installs a missing CLI mid-session, reconstruct the host (capabilities do not re-probe).

## Error Surface

```ts
import {
  ActionCapabilityError,
  AdapterUnavailableError,
  SpawnError,
} from '@namzu/computer-use'
```

| Error | Meaning |
|---|---|
| `AdapterUnavailableError` | Mandatory binaries missing at construction (e.g. `xdotool` on Linux X11). `err.missing` lists them, which is the actionable half. |
| `ActionCapabilityError` | The action requires a capability that is `false` (e.g. macOS `mouse_move` without `cliclick`). |
| `SpawnError` | A spawned CLI returned non-zero or timed out. `err.result.stderr` carries the reason, including a TCC or permission rejection verbatim. |

All three are exported, so a host can branch on the type rather than matching
on a message this package is free to reword.

## Design

The adapter contract, the capability protocol and the platform command matrix
are declared in this package's own types and enforced by its tests.

Subprocess rather than a native addon, deliberately. A Rust + napi-rs host
would mean a prebuild for every platform and architecture, a toolchain for
anyone building from source, and a native crash taking the agent's process
with it. Every capability here is a program the operating system already
ships or the user can install with one command, and a failure is an exit code.

## License

FSL-1.1-MIT, converting to MIT two years after each release. Same as
`@namzu/sdk`.
