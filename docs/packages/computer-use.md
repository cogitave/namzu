---
uid: namzu.packages.computer-use
title: Computer use — the platform matrix, capability flags and error surface
description: Reference for @namzu/computer-use: platform adapters and capability flags, plus the error and unknown-outcome contracts that keep state-changing desktop actions from being replayed unsafely.
type: Reference
diataxis: reference
owner: cogitave/namzu
status: active
timestamp: 2026-08-20T00:00:00Z
lastReviewed: 2026-08-31
resource: packages/computer-use/src/index.ts
tags: [computer-use, adapters, reference]
---

# Computer use — the platform matrix, capability flags and error surface

Subprocess-based computer-use host for [`@namzu/sdk`](https://www.npmjs.com/package/@namzu/sdk). Lets namzu agents control a desktop — screenshots, mouse, keyboard — via platform-native CLIs.

> No native addons. No Rust toolchain. No per-platform prebuild packages. No CFRunLoop pump. Just `spawn()` and the CLIs already on your OS.


## Usage

```ts
import {
  SubprocessComputerUseHost,
  type SubprocessComputerUseHostOptions,
} from '@namzu/computer-use'
import { createComputerUseTool, ToolRegistry } from '@namzu/sdk'

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

const registry = new ToolRegistry()
registry.register(createComputerUseTool(host))
```

The tool is a single `computer_use` action with a discriminated-union input:

```ts sketch
{ type: 'screenshot' }
{ type: 'cursor_position' }
{ type: 'mouse_move';  to: { x, y } }
{ type: 'mouse_click'; at: { x, y }, button: 'left' | 'right' | 'middle' }
{ type: 'mouse_drag';  from: { x, y }, to: { x, y }, button }
{ type: 'scroll';      at: { x, y }, direction, amount }
{ type: 'type_text';   text }
{ type: 'key';         keys }     // e.g. "ctrl+c", "cmd+shift+t", "Return"
```

Screenshots return a short description in `ToolResult.output` and the image as
an image block in `ToolResult.content`. A driver declaring
`supportsToolResultImages: true` receives pixels rather than base64 text; an
incompatible driver produces a capability warning before its next request, or
a strict run refuses that request. Destructive actions
(click/drag/type/key/scroll) surface as `isDestructive === true` so namzu's HITL
layer can gate them.

The built-in presenter turns the model-facing action object into operator text:
`Capture screenshot`, `Press CTRL+R`, `Type "powershell"`, and coordinate-aware
pointer labels. Successful `ok` acknowledgements do not consume a second
transcript row. Screenshot dimensions and every failure are retained.

## Platform Matrix

| OS / Server | Screenshot | Mouse | Keyboard | Cursor Pos | Install |
|---|---|---|---|---|---|
| **macOS** | `screencapture` (built-in) | `osascript` click / `cliclick` for move+drag+right-click | `osascript` keystroke | via `cliclick` | `brew install cliclick` (optional, for move/drag/cursor-pos) |
| **Linux X11** | `maim` | `xdotool` | `xdotool` | `xdotool` | `apt install xdotool maim` / `dnf install …` / `pacman -S …` |
| **Linux Wayland** | `grim` (wlroots) | `ydotool` (needs uinput daemon) | `wtype` or `ydotool` | — | `apt install grim wtype ydotool` + start `ydotoold` |
| **Windows** | PowerShell `System.Drawing` | `SendInput` via inline C# | `SendKeys` | `Cursor::Position` | `pwsh` or `powershell.exe` (built-in) |
| **WSL → Windows** | PowerShell `System.Drawing` | `SendInput` via inline C# | `SendKeys` | `Cursor::Position` | Windows `powershell.exe` through WSL interop |

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
- WSL targets the paired Windows desktop, not the WSLg compositor. WSL's
  `DISPLAY` and `WAYLAND_DISPLAY` therefore do not override the interop route.

## Capability Flags

`host.capabilities` is frozen at `initialize()` and reflects what actually works, not what the action union permits. The tool layer rejects unsupported actions before hitting the adapter, so the model gets a clean error instead of a hang.

If the user installs a missing CLI mid-session, reconstruct the host (capabilities do not re-probe).

## Error Surface

```ts
import {
  ActionCapabilityError,
  AdapterUnavailableError,
  ComputerUseOutcomeUnknownError,
  SpawnError,
} from '@namzu/computer-use'
```

| Error | Meaning |
|---|---|
| `AdapterUnavailableError` | Mandatory binaries missing at construction (e.g. `xdotool` on Linux X11). `err.missing` lists them, which is the actionable half. |
| `ActionCapabilityError` | The action requires a capability that is `false` (e.g. macOS `mouse_move` without `cliclick`). |
| `SpawnError` | A spawned CLI returned non-zero or timed out. `err.result.stderr` carries the reason, including a TCC or permission rejection verbatim. |
| `ComputerUseOutcomeUnknownError` | A click, drag, scroll, text entry or key action started, then its subprocess timed out or closed non-zero. The desktop may already have changed, so the action must not be replayed automatically. `action`, `timedOut`, `exitCode`, `outcome: 'unknown'` and `retrySafety: 'unsafe'` are stable fields. |

All four are exported, so a host can branch on the type rather than matching
on a message this package is free to reword. The SDK also recognises the
unknown-outcome shape structurally and preserves it in `ToolResult.data`; this
keeps the model-facing warning intact when the host package and SDK were
installed separately.

`SpawnError` does not always imply an unknown outcome. Screenshots, cursor
reads and repeated moves to the same coordinate keep their ordinary diagnosis.
A raw process-start failure also remains ordinary because no subprocess crossed
the execution boundary. The fail-closed classification applies only when a
state-changing action actually started and no clean completion can be proven.

## Design

The adapter contract, the capability protocol and the platform command matrix
are declared in this package's own types and enforced by its tests.

Subprocess rather than a native addon, deliberately. A Rust + napi-rs host
would mean a prebuild for every platform and architecture, a toolchain for
anyone building from source, and a native crash taking the agent's process
with it. Every capability here is a program the operating system already
ships or the user can install with one command, and a failure is an exit code.
