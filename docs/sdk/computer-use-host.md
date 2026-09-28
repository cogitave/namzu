---
type: Reference
title: The computer-use host contract
description: What a ComputerUseHost promises the computer_use tool — display and window pixel spaces, capture identity, and optional window, region-capture and accessibility-tree methods.
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

Display coordinates and sizes are in **physical pixels**, never logical
points or DPI-scaled units. A 3440x1440 monitor at 150 % scaling is
3440x1440 here, and a Retina panel is its full backing resolution. Window
input has its own PNG pixel space, which the driver may have downscaled.

- A point in an action (`mouse_click.at`, `mouse_drag.from`/`to`, …) is
  relative to the top-left of the display the host last captured (the primary
  display until a host offers display selection). The host adds that
  display's origin.
- The rectangle given to `captureRegion` is display-relative in the same way.
- Window and accessibility-element bounds are the exception: they are in
  **virtual-desktop** physical pixels, because a window can span displays.
- A `captureWindow(id)` PNG uses its **own image pixels**. `executeWindow`
  accepts points in that PNG, not display pixels. The host maps those points
  to the real window; callers must not add the window's virtual-desktop bounds
  to them. Some window capture backends crop the border and downscale before
  returning the PNG.

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
the method exists; either alone is not enough. `windowScroll` modifies the
window input path: `false` refuses scoped pixel scroll before a batch starts;
`true` or absent leaves it to the host.

| Flag | Methods | Used by |
| --- | --- | --- |
| `windows` | `listWindows()`, `focusWindow(id)` | `list_windows`, `focus_window` |
| `windowCapture` | `captureWindow(id)`, `executeWindow(captureId, action)` | `screenshot {window_id}`, then scoped click, drag, scroll, text or key |
| `windowScroll` | No extra method; `false` refuses scoped pixel scrolling before a batch starts | Hosts whose `executeWindow` cannot safely scroll |
| `regionCapture` | `captureRegion(rect)` | `zoom`, which otherwise crops a full capture |
| `uiTree` (experimental) | `uiSnapshot(windowId?)`, `uiAct(ref, action, value?)` | `ui_snapshot`, `ui_act` |

`listWindows()` returns `WindowInfo` records (`id`, `title`, `app`, `pid`,
`bounds`, `focused`, `minimized`); `id` is opaque and host-defined. The
operating system can refuse to bring a window forward, so `focusWindow(id)`
reports `{ ok, focusedId }` from what is actually in front afterwards, not
from the request. `captureRegion(rect)` returns a `ScreenshotResult` whose
`width` and `height` are the region's.

`captureWindow(id)` returns a `WindowScreenshotResult`: PNG bytes and their
exact width and height, the named `WindowInfo`, and an opaque `captureId`.
This path can be offered even when display `screenshot`, `mouse` and `keyboard`
are false. Such a host requires `window_id` for a screenshot and refuses a
plain display screenshot; scoped input uses its own `executeWindow` method.
`executeWindow(captureId, action)` takes a click, drag, scroll, text or key
action against that capture. Text and key actions can request `foreground`
delivery for input that the host cannot send in the background; the pinned
Windows driver still validates the captured PID and HWND before keyboard
input. It does not offer an atomic focus-by-pixel text or key action. The pinned
Windows adapter reports `windowScroll: false` and refuses window pixel
scrolling because the driver's
background path cannot deliver it and its foreground wheel cannot prove
which window receives the event.
The host rejects the token when another window
capture changes its coordinate mapping, when the target PID/HWND disappears,
its bounds change, or the driver session restarts. A failed window capture
never falls back to a whole-display screenshot. `mouse_move` and
`cursor_position` have no window-scoped form: the Windows driver's window move
animates only an overlay, not the OS cursor.

`UiSnapshot`, `UiElement`, `UiElementAction` and `UiActResult` describe an
accessibility tree (Windows UI Automation, macOS AX, AT-SPI, or a driver that
wraps one). `uiSnapshot(windowId?)` reads one window — the one in front when
the id is omitted — and returns its `root`, optionally its `title`, `app` and
`truncated`. Each element has an opaque `ref` valid until the host's next
snapshot (empty for an element nothing can be done with: a label, a group,
which is in the tree for what it says), a platform `role`, `name`, optional
`value`, `automationId`, virtual-desktop `bounds`, `states` (`disabled`,
`selected`, …) and the `actions` it accepts: `invoke`, `set_value`, `toggle`,
`select`, `expand`, `collapse`, `focus`, `scroll_into_view`.
`uiAct(ref, action, value?)` reports `{ ok, detail? }`; a host says why in
`detail` when it could not act (a stale ref, a disabled control) rather than
throwing, and reports an action whose outcome it cannot know (its driver died
mid-request) as `ok: false` with a detail that says so, never as a retry.

These shapes are `@experimental`: `@namzu/computer-use`'s Windows backend is
the first host that implements them, and they may still change in a minor
release. How the tool shows them to the model is in
[the computer_use tool](computer-actions.md#a-windows-controls).

The contract applies to any backend: a custom helper and a desktop driver
both fit, and a host without optional methods is still a complete host.

## Windows driver session recovery

The cua-driver backend uses an implicit session on its long-lived MCP
connection. The driver expires that session after five minutes without a
completed call. An action then receives a structured `session_ended` refusal
before desktop dispatch. The adapter calls `start_session` to revive the
implicit session, restores its disabled agent cursor, and retries the refused
call once. Concurrent refusals share one revival.

Each snapshot gives callers fresh opaque refs and keeps cua-driver's element
tokens inside the adapter. If a UI action encounters session expiry, the adapter
revives the session but reports its ref as stale. A restarted driver also makes
existing refs stale, even when it later reuses the same raw token. Take a new
`uiSnapshot` before acting on a control again. A driver crash, timeout, or any
response without the exact structured refusal does not trigger an action retry,
because the action may already have reached the desktop.

For window pixels, even the exact pre-dispatch `session_ended` refusal makes
the previous screenshot stale: the driver's per-process resize mapping may
have been reset. The adapter revives the session but refuses the scoped input
until a new `captureWindow` succeeds. Its pinned cua-driver 0.28.2 backend
uses `get_window_state` without a UIA walk for capture and sends `scope:
"window"` with the captured PID and HWND for input. It also checks the same
window's bounds immediately before each input. Window capture normally uses
PrintWindow or Windows Graphics Capture; the driver's screen-region fallback
can still see an occluding window, and browser permission bubbles rendered
outside the native window may be absent. The host reports capture coverage
when the driver does.
