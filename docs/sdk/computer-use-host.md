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

`UiSnapshot`, `UiElement`, `UiElementAction`, `UiSnapshotOptions` and `UiActResult` describe an
accessibility tree (Windows UI Automation, macOS AX, AT-SPI, or a driver that
wraps one). `uiSnapshot(windowId?, options?)` reads one window — the one in
front when the id is omitted — and returns its `root`, optionally its `title`,
`app`, `truncated`, `total`, `outline`, `region` and `next`. Each element has
an opaque `ref` that names the control, not one reading of it (empty for an
element nothing can be done with: a label, a group, which is in the tree for
what it says), a platform `role`, `name`, optional
`value`, `automationId`, virtual-desktop `bounds`, `states` (`disabled`,
`selected`, …) and the `actions` it accepts: `invoke`, `set_value`, `toggle`,
`select`, `expand`, `collapse`, `focus`, `scroll_into_view`.

A host may return a large window as an outline. An element then carries
`hiddenChildren`, the number of its children left out, and the snapshot sets
`outline` and `total` (every control the window holds). An element with
`hiddenChildren` has a `ref` even when nothing can be done to it: it is a
region, and `uiSnapshot(windowId, { root: ref })` reads just that region (with
`region: true`; `offset` and the reported `next` page through a long one).
`{ query }` keeps only the controls whose text matches, with the elements above
them. Refs outside the opened region stay valid.

`uiAct(ref, action, value?)` reports `{ ok, detail?, code?, delivery?,
retrySafety?, readBack? }`; `code` is `STALE_REF` (the control the ref named is
gone, or can no longer be acted on) or `AMBIGUOUS_TARGET` (several controls fit
and the host did not guess); both mean nothing was sent. A host says why in `detail` when it could not act (a stale ref,
a disabled control) rather than throwing, and reports an action whose outcome
it cannot know (its driver died mid-request) as `ok: false` with a detail that
says so, never as a retry.

`delivery` is `delivered_verified` (the host read the state back and it
matches), `delivered_unverified` (sent, nothing confirmed it; a failed or
impossible read-back lands here) or `not_delivered` (refused before any input,
or a read-back proved no change). `retrySafety` is `safe` when nothing reached
the target and `unsafe` when it may have; a timeout is never `not_delivered`.
`executeWindow` may return a `WindowInputResult` `{ delivery, retrySafety,
detail? }` and a display `execute` may return `{ type: 'ok', delivery?,
retrySafety?, detail? }`; a host that returns nothing keeps the plain `done`.
The tool turns these into the model's wording (see
[the computer_use tool](computer-actions.md#what-an-action-reports-about-itself)).

These shapes are `@experimental`: `@namzu/computer-use`'s Windows backend is
the first host that implements them, and they may still change in a minor
release. How the tool shows them to the model is in
[the computer_use tool](computer-actions.md#a-windows-controls).

The contract applies to any backend: a custom helper and a desktop driver
both fit, and a host without optional methods is still a complete host.

## Using the screen: turns and the foreground ladder

A host that can only deliver some input in the foreground must not take the
screen from a person who is using it. Two optional methods carry the turn to
it: `beginTurn(turnId)` (called by the tool at the start of every call) and
`endTurn()` (called when the turn finishes or is cut short). A host keeps per
turn state with them: a stop the user asked for with Escape, permissions the
user refused, and anything it holds (a lease on the screen, an input monitor).
`FocusWindowResult` gains optional `delivery`, `retrySafety` and `detail`: a
host that did not try at all (the screen was in use, a prompt had it, the user
said no) answers `{ ok: false, delivery: 'not_delivered', retrySafety: 'safe',
detail }`.

`@namzu/computer-use` implements this on Windows; see
[the foreground ladder](foreground-ladder.md).

## Windows driver session recovery

The cua-driver backend uses an implicit session on its long-lived MCP
connection. The driver expires that session after five minutes without a
completed call. An action then receives a structured `session_ended` refusal
before desktop dispatch. The adapter calls `start_session` to revive the
implicit session, restores its disabled agent cursor, and retries the refused
call once. Concurrent refusals share one revival.

The adapter keeps cua-driver's element tokens to itself and gives callers
opaque refs that name controls. Each ref carries the evidence that finds its
control again: the native or automation id, its role and name, its place in the
tree (the child indexes from the root) and its window (HWND and owning process
id; cua-driver does not report a process start time). A token dies when the
window is read again, so a ref read more than 3 s ago, or in an older read of
its window, or in an older driver session, is first checked against a new read:
the id (with the same role and name) when it has one, else the node at the
stored place when it is still the same role and name, else a search of the
tree for that role and name. One fit is the control; several are
`AMBIGUOUS_TARGET`; none, or a control that lost its patterns, is `STALE_REF`;
a window that closed is `STALE_REF`. The same id under another name is not the
control. A driver refusal of a token a newer read replaced is not an error
either: the adapter reads again and retries once, since the driver refused
before acting. After a session expiry or a driver restart the refs are
resolved the same way. A driver crash, timeout, or any response without the
exact structured refusal does not trigger an action retry, because the action
may already have reached the desktop.

A window with more than 220 shown controls is returned as an outline of about
150: breadth first, at most 12 children per element, a region's page at most 60
of its children. Regions carry `hiddenChildren` and a ref. The adapter walks a
window with the driver's own 5 000 node cap (it cuts a walk silently, so a walk
within 5% of the cap is reported `truncated`), and reads a browser window once
more when its first walk shows only the frame, because the page tree is built on
the first request. The driver puts rows under the wrong parent when it leaves a
container out; a button or link is never made the parent of such rows.

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
