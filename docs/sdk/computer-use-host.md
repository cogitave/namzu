---
type: Reference
title: The computer-use host contract
description: What a ComputerUseHost promises the computer_use tool — physical pixels everywhere, the display a capture shows, and the optional window, region-capture and accessibility-tree methods behind their capability flags.
resource: packages/sdk/src/types/computer-use/index.ts
tags: [sdk, computer-use, hosts, contracts]
generated: { by: human:bahadirarda, at: 2026-09-24T00:00:00Z }
---

# The computer-use host contract

`ComputerUseHost` is the seam between the SDK's `computer_use` tool and
whatever actually drives a desktop: `@namzu/computer-use`'s subprocess
adapters, a persistent helper process, or a third-party driver. The tool owns
everything the model sees — image size, coordinate mapping, batching; the host
owns the pixels and the input events. This page is the part both sides must
agree on.

## Units

Every coordinate and size that crosses the interface is in **physical
pixels**: the pixels of the captured bitmap, never logical points or
DPI-scaled units. A 3440x1440 monitor at 150 % scaling is 3440x1440 here, and
a Retina panel is its full backing resolution.

- A point in an action (`mouse_click.at`, `mouse_drag.from`/`to`, …) is
  relative to the top-left of the display the host last captured (the primary
  display until a host offers display selection). The host adds that
  display's origin.
- The rectangle given to `captureRegion` is display-relative in the same way.
- Window and accessibility-element bounds are the exception: they are in
  **virtual-desktop** physical pixels, because a window can span displays.

A host that works in logical units internally (macOS input APIs, a
DPI-unaware process on Windows) converts at its own boundary. The tool never
multiplies by `scaleFactor`.

## What a capture carries

`ScreenshotResult` is the PNG plus its physical `width` and `height`, and
`display`:

| Field | Meaning |
| --- | --- |
| `id` | Stable for the host's lifetime. |
| `x`, `y` | The display's origin in the virtual desktop; negative left of or above the primary. |
| `width`, `height` | The display's physical size. |
| `scaleFactor` | Physical pixels per logical pixel (1 at 96 DPI, 1.5 at 150 %, 2 on Retina). Reported, not applied. |
| `primary` | Optional; true for the operating system's primary display. |

`display` is optional in the type so that hosts written before it existed
keep compiling. Without it the tool assumes one display at the origin whose
size is the capture's own and whose scale factor is 1.

## Optional methods and their flags

A method is offered to the model only when its capability flag is `true` and
the method exists; either alone is not enough.

| Flag | Methods | Used by |
| --- | --- | --- |
| `windows` | `listWindows()`, `focusWindow(id)` | `list_windows`, `focus_window` |
| `regionCapture` | `captureRegion(rect)` | `zoom`, which otherwise crops a full capture |
| `uiTree` (experimental) | `uiSnapshot(windowId?)`, `uiAct(ref, action, value?)` | reserved for accessibility-tree actions |

`listWindows()` returns `WindowInfo` records (`id`, `title`, `app`, `pid`,
`bounds`, `focused`, `minimized`); `id` is opaque and host-defined. The
operating system can refuse to bring a window forward, so `focusWindow(id)`
reports `{ ok, focusedId }` from what is actually in front afterwards, not
from the request. `captureRegion(rect)` returns a `ScreenshotResult` whose
`width` and `height` are the region's.

`UiSnapshot`, `UiElement`, `UiElementAction` and `UiActResult` describe an
accessibility tree (Windows UI Automation, macOS AX, AT-SPI, or a driver that
wraps one): each element has an opaque `ref` valid until the next snapshot,
a platform `role`, `name`, optional `value`, `automationId`, virtual-desktop
`bounds`, `states` and the `actions` it accepts. These shapes are marked
`@experimental` and may change in a minor release until a host ships them.

Nothing here is specific to one backend: a custom helper and a ready-made
desktop driver fit the same interface, and a host that has none of the
optional methods is still a complete host.
