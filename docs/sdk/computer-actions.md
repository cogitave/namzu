---
type: Reference
title: Computer action capabilities
description: Exact desktop action and mouse-button declarations shared by tool advertising and admission.
resource: packages/sdk/src/types/computer-use/index.ts
tags: [sdk, computer-use, tools, capabilities]
---

# Computer action capabilities

`ComputerUseCapabilities.supportedActions` optionally declares an exact action
subset. It refines the broad screenshot, mouse, keyboard and cursor flags;
it cannot enable a disabled broad capability. An absent subset preserves the
existing broad-flag interpretation for custom hosts, while an empty subset
means no action is available.

`mouseClickButtons` and `mouseDragButtons` optionally restrict each gesture's
buttons separately. Empty button lists disable that gesture. Missing lists
leave button validation to the host. Shipped adapters freeze their action lists
after probing; availability still depends on OS permissions and a live desktop.

`createComputerUseTool` derives the available-action description and model
schema from those capabilities and rejects unsupported actions/buttons before
calling the host. The runtime schema still understands the complete action
union, so unsupported calls receive a capability error. A wholly unavailable
host retains the general schema for diagnostic calls, avoiding an invalid empty
enum on provider transports, and refuses all execution.

| Adapter | Action limits |
| --- | --- |
| Windows / WSL | Screenshot, cursor, move, click, drag, scroll, text and keys. |
| X11 | Screenshot depends on maim; input and cursor depend on xdotool. |
| Wayland | Screenshot depends on grim; mouse actions on ydotool; keyboard on wtype or ydotool. Cursor position is unavailable. Daemon permissions are checked by the underlying operation, not established by binary detection. |
| macOS | Screenshot and keyboard use system tools. Move, drag and cursor require cliclick; scroll is unavailable. Without cliclick only left clicks are supported; with it left/right clicks are supported. Drag supports only the left button. |

macOS middle-click and non-left drag requests are refused even when the adapter
is invoked directly. They must never become a triple click or a left drag. The
[cliclick command reference](https://github.com/BlueM/cliclick#usage) distinguishes
right click, triple click and drag gestures; `tc` is not a middle-click command.

These declarations do not add browser element references, remote desktop
allocation or human-control handover. Those remain separate capabilities in
the [framework audit](framework-gap-audit.md).
