---
title: Platform Support
description: Operating-system support matrix, permissions, and error behavior for @namzu/computer-use.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/computer-use", "@namzu/sdk"]
---

# Platform Support

`@namzu/computer-use` is intentionally explicit about host support. The package probes the real host environment and exposes only the capabilities that actually work, which makes this page part of the operational contract rather than optional background reading.

## 1. Platform Matrix

| OS or server | Screenshot | Mouse | Keyboard | Cursor position | Typical setup |
| --- | --- | --- | --- | --- | --- |
| macOS | `screencapture` | `osascript` for click, `cliclick` for richer mouse control | `osascript` | `cliclick` | Built-ins plus optional `brew install cliclick` |
| Linux X11 | `maim` | `xdotool` | `xdotool` | `xdotool` | Install `xdotool` and `maim` |
| Linux Wayland | `grim` on wlroots compositors | `ydotool` | `wtype` or `ydotool` | Not supported | Install `grim`, `wtype`, `ydotool`, and run `ydotoold` |
| Windows | PowerShell `System.Drawing` | `SendInput` | `SendKeys` | `Cursor::Position` | PowerShell available on the host |

## 2. macOS Permissions

The first successful run on macOS usually depends on two operating-system permissions:

- Screen Recording is required for screenshots with visible window contents.
- Accessibility is required for clicks, key presses, and typed text.

If these permissions are missing, the underlying subprocess can fail and surface the OS error back through stderr.

## 3. Linux Caveats

Linux behavior depends on the display server:

- X11 is the most complete path in the current package.
- Wayland support is targeted at wlroots-style compositors for screenshot capture.
- Wayland does not offer a standard cross-desktop cursor-position API in this adapter.
- `ydotool` requires the `ydotoold` daemon and suitable access to `/dev/uinput`.

## 4. Windows Caveats

Windows input simulation requires an interactive user session. If the workstation is locked or sleeping, keyboard and mouse events can fail even though the package is installed correctly.

## 5. Error Model

Three error families matter operationally:

| Error | Meaning |
| --- | --- |
| `AdapterUnavailableError` | A required platform binary or host condition is missing |
| `ActionCapabilityError` | The requested action is not supported by the current capability map |
| `SpawnError` | A subprocess failed, timed out, or returned a non-zero exit code |

These errors are designed to fail fast so unsupported desktop actions do not silently degrade into misleading success signals.

## Related

- [Computer Use](./README.md)
- [Action Reference](./action-reference.md)
- [Host Lifecycle](./host-lifecycle.md)
- [SDK Tools](../sdk/tools/README.md)
- [Adapter Types Source](https://github.com/cogitave/namzu/blob/main/packages/computer-use/src/adapters/types.ts)
- [Spawn Helper Source](https://github.com/cogitave/namzu/blob/main/packages/computer-use/src/util/spawn.ts)
