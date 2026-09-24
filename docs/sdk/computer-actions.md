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
| Windows / WSL | Screenshot, cursor, move, click, drag, scroll, text and keys, every button. With the cua-driver backend also `windows` (list and focus); no region capture. |
| X11 | Screenshot depends on maim; input and cursor depend on xdotool. |
| Wayland | Screenshot depends on grim; mouse actions on ydotool; keyboard on wtype or ydotool. Cursor position is unavailable. Daemon permissions are checked by the underlying operation, not established by binary detection. |
| macOS | Screenshot and keyboard use system tools. Move, drag and cursor require cliclick; scroll is unavailable. Without cliclick only left clicks are supported; with it left/right clicks are supported. Drag supports only the left button. |

macOS middle-click and non-left drag requests are refused even when the adapter
is invoked directly. They must never become a triple click or a left drag. The
[cliclick command reference](https://github.com/BlueM/cliclick#usage) distinguishes
right click, triple click and drag gestures; `tc` is not a middle-click command.

## Windows

`@namzu/computer-use` drives the Windows desktop — natively or from WSL —
through a pinned build of cua-driver (MIT, `github.com/trycua/cua`), one
process for the host's lifetime, and falls back to one `powershell.exe` per
action when that build cannot be downloaded, verified or started. The
package README has the download, the environment it runs with, the
`NAMZU_CUA_DRIVER` switch and the measured latencies. Both backends work in
physical pixels: cua-driver is DPI aware, and the PowerShell scripts make
their process per-monitor DPI aware before reading a bound or moving the
pointer.

What each backend declares:

| Backend | Actions | `windows` | `regionCapture` | Buttons |
| --- | --- | --- | --- | --- |
| cua-driver | all eight | `true` | `false` | left, right, middle for click and drag |
| PowerShell | all eight | absent | absent | not declared (all three work) |

Every cua-driver input goes to its desktop scope — real input at screen
coordinates. A click there first brings the window under the point to the
front; when Windows refuses, nothing is clicked and the call fails. After a
click cua-driver also checks that the clicked window's process is still in
front, and a click that closed its own window (a dialog's "Don't Save")
fails that check although it happened; the adapter reports such a click as
done rather than invite a second one.

### Verifying a new cua-driver build

Changing the pinned build means changing the four hashes in
`packages/computer-use/src/adapters/cua-driver/provision.ts` and repeating,
on a real Windows desktop, what was done for 0.28.2 on 2026-09-24 (Windows 10
22H2 from WSL2, one 3440x1440 display at 100 %), acting only on Notepad
windows opened for the purpose:

1. Capture: 3440x1440 PNG, `display` `{ id: 'primary', x: 0, y: 0, scaleFactor: 1 }`.
2. Move to three physical points and read the cursor back: exact each time,
   and the same from a separately started DPI-aware `GetCursorPos`.
3. With another Notepad in front, click the pixel centre of the first one's
   title bar, found in the capture (rows 151–180, centre (3010, 165)):
   `GetForegroundWindow` is that Notepad.
4. Type `Merhaba dünya ığüşöçİ` into it and read the edit control back with
   `WM_GETTEXT`: identical bytes. The key `/` arrives as `/`.
5. `listWindows()` lists it; `focusWindow(id)` from another application in
   front returns `{ ok: true }` and `GetForegroundWindow` agrees.
6. Close it with Alt+F4 and click "Don't Save", found in a capture of the
   dialog: the process exits, no `cua-driver.exe` stays running, and the
   Windows user profile has no `.cua-driver` directory afterwards.

These declarations do not add browser element references, remote desktop
allocation or human-control handover. Those remain separate capabilities in
the [framework audit](framework-gap-audit.md).
