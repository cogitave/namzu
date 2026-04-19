---
title: Computer Use
description: Add desktop screenshots, mouse input, and keyboard input to Namzu through @namzu/computer-use.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/computer-use", "@namzu/sdk"]
---

# Computer Use

`@namzu/computer-use` is the published desktop-control package for Namzu. It provides a `SubprocessComputerUseHost` that plugs into `createComputerUseTool()`, so GUI automation stays inside the normal SDK tool pipeline instead of creating a second runtime path.

## 1. Install

```bash
pnpm add @namzu/sdk @namzu/computer-use
```

## 2. Minimal Setup

```ts
import { ToolRegistry, createComputerUseTool } from '@namzu/sdk'
import { SubprocessComputerUseHost } from '@namzu/computer-use'

const host = new SubprocessComputerUseHost()
await host.initialize()

const tools = new ToolRegistry()
tools.register(createComputerUseTool(host))
```

`host.initialize()` detects the current display server, loads the matching adapter, and freezes the capability map for the current session.

## 3. What the Host Actually Does

`SubprocessComputerUseHost` uses platform-native subprocesses instead of native addons. That gives the package a few deliberate properties:

- no Rust or native build chain requirement
- no prebuilt binary matrix to manage
- capability detection tied to real host conditions
- straightforward failure surfaces when system binaries or permissions are missing

## 4. Action Surface

The wrapped tool exposes a discriminated action union:

| Action | Purpose |
| --- | --- |
| `screenshot` | Capture the current display as PNG data |
| `cursor_position` | Return the current cursor coordinates when supported |
| `mouse_move` | Move the pointer |
| `mouse_click` | Click at a target point |
| `mouse_drag` | Drag from one point to another |
| `scroll` | Scroll in a direction by a requested amount |
| `type_text` | Type a text string |
| `key` | Send a chord or single key such as `cmd+shift+t` or `Return` |

Screenshots are returned as base64 PNG in `ToolResult.output`, with metadata such as MIME type and image dimensions in `ToolResult.data`.

Read [Action Reference](./action-reference.md) for the full per-action contract.

## 5. Capability Model

The package does not assume every host can do every action. Capabilities are frozen on initialization:

| Capability field | Meaning |
| --- | --- |
| `displayServer` | Host environment such as `darwin`, `x11`, `wayland`, `win32`, or `unknown` |
| `screenshot` | Screenshot capture is available |
| `mouse` | Mouse movement and click actions are available |
| `keyboard` | Typing and key actions are available |
| `cursorPosition` | Cursor position lookup is available |
| `clipboard` | Clipboard access is available on the adapter |

If an action targets a capability that is unavailable, the tool returns a clear failure instead of hanging.

## 6. Host Lifecycle

The recommended lifecycle is:

1. construct the host
2. call `await host.initialize()`
3. inspect or log `host.capabilities`
4. register `createComputerUseTool(host)` in a `ToolRegistry`
5. dispose or recreate the host when the environment changes

Read [Host Lifecycle](./host-lifecycle.md) for the detailed lifecycle and failure model.

## 7. Operational Notes

- This package uses platform-native CLIs through subprocesses instead of native addons.
- Recreate the host if you install missing system binaries mid-session; capabilities are not re-probed automatically.
- Review [Platform Support](./platform-support.md) before rolling this out on multiple operating systems.
- Treat screenshots as the primary grounding step before pointer actions.

## Related

- [Action Reference](./action-reference.md)
- [Host Lifecycle](./host-lifecycle.md)
- [Platform Support](./platform-support.md)
- [SDK Tools](../sdk/tools/README.md)
- [SDK Computer Use Types](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/types/computer-use/index.ts)
- [SubprocessComputerUseHost Source](https://github.com/cogitave/namzu/blob/main/packages/computer-use/src/SubprocessComputerUseHost.ts)
