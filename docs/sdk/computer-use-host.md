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
| `maxClickCount` | No extra method; `2` or `3` lets `mouse_click` carry `count` up to that many clicks in a row (absent means 1) | Hosts whose click can repeat; `count` is sent to `execute` and `executeWindow` only above 1 |
| `regionCapture` | `captureRegion(rect)` | `zoom`, which otherwise crops a full capture |
| `uiTree` (experimental) | `uiSnapshot(windowId?)`, `uiAct(ref, action, value?)` | `ui_snapshot`, `ui_act` |
| none (the method alone) | `settle({ windowId?, budgetMs }, signal?)` | the pause before the screenshot that follows an action |

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
Windows adapter reports `windowScroll: true`: the driver (0.38 and later)
posts a window scroll to the window itself, and takes a point to pick a nested
scrolling surface only in the foreground.
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
detail?, readBack? }` and a display `execute` may return `{ type: 'ok', delivery?,
retrySafety?, detail? }`; a host that returns nothing keeps the plain `done`.
The tool turns these into the model's wording (see
[the computer_use tool](computer-actions.md#what-an-action-reports-about-itself)).

These shapes are `@experimental`: `@namzu/computer-use`'s Windows backend is
the first host that implements them, and they may still change in a minor
release. How the tool shows them to the model is in
[the computer_use tool](computer-actions.md#a-windows-controls).

`settle(request, signal?)` is optional and has no flag. After a batch that
changed something the tool waits `settleMs` (500 by default) before it takes
the screenshot it returns. A host that is told by the window itself when it has
stopped changing implements `settle`: the tool passes the window the batch
acted in (`windowId`, absent for display input) and its `settleMs` as
`budgetMs`, and the host resolves `{ waitedMs, changed }` as soon as the window
changed and then stayed quiet, or after the whole budget when nothing changed
at all, so it is never slower than the fixed pause. Resolving `undefined` or
rejecting means "I cannot say"; the tool then sleeps the fixed time as it
always did, and so it does for a host without the method. The default
`settleMs` is unchanged. `@namzu/computer-use` implements it for the Windows
driver backend (see [the accessibility host](#the-accessibility-host-the-window-list-and-waiting-for-a-window-to-settle)).

The contract applies to any backend: a custom helper and a desktop driver
both fit, and a host without optional methods is still a complete host.

## Cancellation and a locked computer

Every method that reaches the desktop (`execute`, `listWindows`, `focusWindow`,
`captureWindow`, `executeWindow`, `captureRegion`, `uiSnapshot`, `uiAct`) takes a
trailing optional `signal: AbortSignal`, the tool call's cancellation. On abort
a host stops waiting for the desktop and answers at once: an action that may
already have been sent answers `delivered_unverified` with `retrySafety:
'unsafe'`, one that provably was not answers `not_delivered`, `'safe'`, and a
read throws. A host that ignores the argument stays correct, only slower to stop.

A host that can tell that the computer is locked refuses before it observes or
acts, with a typed refusal (an action: `not_delivered`, `safe`; a read: an error
whose `code` is `computer_locked`), and does not return a capture taken while it
was locked. `SubprocessComputerUseHost` does this on Windows from the foreground
helper; see [the foreground ladder](foreground-ladder.md#a-locked-computer).

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

## Showing that an agent is at work: the presence overlay

While the Windows adapter operates a window, a person must be able to see that
an agent is using the computer. Two things are drawn, both by the package and
neither by the desktop driver (the driver's own cursor can only switch between
themes it has installed, and its glide cost 0.9 to 3.8 s per action):

- an **agent cursor**: a smooth, anti-aliased arrow (about 22 by 15 logical
  pixels) in Namzu green: a light-to-deep green gradient, a fine dark outline,
  a soft highlight down its upper-left edge and a soft drop shadow, so it reads
  on light and dark windows. It is separate from the real pointer, which it
  never moves. The first time it shows in a window it fades in and grows from
  85 % over 160 ms instead of popping in. After that it glides to each action
  point along a gentle curve (the path bows by a tenth of its length, always
  to the same side of the line, so repeated moves do not zigzag), in 140 to
  420 ms depending on the distance, eased in and out and at sub-pixel
  positions. On a click it dips to 88 % over 70 ms and returns over 110 ms,
  and a circular ripple (2 px green stroke, 5 to 26 px over 420 ms, fading
  out) spreads from the tip once it arrives; typing makes a smaller, softer
  ripple (4 to 14 px) and no dip. For a control action it goes to the centre
  of the control; for typing it stays where it is.
- a **presence border**: a smooth rounded frame inside the window being
  operated (corner radius 8 px): a 2 px green stroke at about 60 % opacity with
  a soft 8 px glow fading inward. It breathes very gently (plus or minus 8 %
  every 2.4 s) while the cursor is active, follows the window when it moves or
  is resized, holds for 2 s after the last action, fades out over 0.5 s with
  the cursor, and disappears at once when the turn ends (`endTurn`) or the host
  is disposed. It also shows while the foreground ladder is in use.

Every size is in logical pixels and is multiplied by the operated window's
display scale (its DPI over 96, read again when the window changes), so the
cursor is the same visual size on a 100 %, 150 % or 200 % display. The pointer
is drawn once per scale with its shadow baked in, and the two windows' bitmaps
are allocated once per size; the 16 ms timer only compares, so while nothing
moves, appears or fades the cursor window is neither redrawn nor updated, and
the frame is updated only for its breathing. The numbers (durations, sizes, the
curve and easing formulas) are in `presence/motion.ts`, written into the
helper script and pinned by tests.

Both are drawn by one long-lived PowerShell helper that starts the first time
the model lists windows (about 0.35 s, compiling a small library) and is
reused: an update is one line written to it, about 0.02 ms on the host side. Its
script is handed over as the first line of its input, since the encoded script
is longer than a Windows command line.

For development the helper also answers one command that draws nothing on the
screen: `{"cmd":"preview","dpi":96|144|192,"state":"rest"|"press"|"ripple"|"frame","path":"<png>"}`
renders that state (the pointer, the pointer at the bottom of a click's dip, a
half-grown click ripple, or the frame) to an offscreen bitmap on a mid-grey
checker, a white and a near-black panel, and writes it as a PNG, so the design
can be checked without touching the desktop. `previewCommandLine` in
`presence/preview.ts` builds the line.

The two windows never take input (`WS_EX_TRANSPARENT`), are never activated
(`WS_EX_NOACTIVATE`), are not in the taskbar or alt-tab (`WS_EX_TOOLWINDOW`)
and are excluded from every screen capture (`WDA_EXCLUDEFROMCAPTURE`, Windows
10 version 2004 and later), so the model's own screenshots never contain them.
Windows refuses the exclusion on a window that is already layered, so it is set
first. If it cannot be set, the helper reports it and nothing is shown: an
overlay that could reach a screenshot is worse than none. They are owned by the
operated window, which keeps them directly above it in the z-order, in front of
or behind other windows, without raising it. A window the overlay cannot be
tied to (for instance one running with higher rights) gets no overlay.
The order is set explicitly (right above the operated window, passing over
hidden application windows that cannot be ordered against), so a window opened
after the overlay started gets it too. The helper works in physical pixels
whatever the display scaling, and a helper that ends mid-session is started
again by the next action, up to three times.

Only one cursor is ever shown. The desktop driver draws a cursor of its own
(an animated arrow in a full-screen overlay window).
The adapter switches it off for its session when the driver starts and again
after a session is revived (`set_agent_cursor_enabled` with `enabled: false`; the
driver confirms it and `get_agent_cursor_state` reports `enabled: false`). The
window stays: it is empty, fully transparent and click-through, and with the
cursor off the driver draws nothing into it. There is no environment variable or
configuration key for it; the call is per session. If the driver does not
confirm it (an older build without the tool), Namzu's cursor and border are not
shown at all, so the driver's remains the only one.

On by default on Windows and WSL. Turn it off with the host option
`presence: false` (`SubprocessComputerUseHostOptions`) or the environment
variable `NAMZU_COMPUTER_USE_PRESENCE=off` (`0`, `false`, `no` and `none` also
work). A failure of the overlay never fails or delays an action.

## The accessibility host: the window list and waiting for a window to settle

Two things in the Windows driver backend were slow for a reason that had
nothing to do with the work itself. The driver's `list_windows` took 1.3 to
1.75 s on a real desktop (an uncached accessibility walk, a property read per
window and a process listing on every call), and the window list is read
before each capture and each window input; and the tool paused a fixed 500 ms
after every action whether the window had changed in 5 ms or not at all.

`@namzu/computer-use` therefore keeps a second long-lived helper, the
**accessibility host**, started the same way as the presence overlay (a
PowerShell process whose C# library is compiled on start, its script handed
over as the first line of its input, one JSON object per line in each
direction, ended by its input closing). Everything it answers is behind the
platform-neutral `AccessibilityBackend` interface (`a11y/interface.ts`, its
types free of Windows terms: a window is a `windowId` string, rectangles are
virtual-desktop physical pixels), so a macOS or a Linux backend only adds a
file that implements it. The Windows implementation is `WindowsA11yHost`.

| Question | What answers it |
| --- | --- |
| `listWindows()` | Win32 window enumeration only, no accessibility call: visible, not cloaked (other virtual desktops, suspended apps), not a tool window, with an owner or without one as asked; each with process id and name, title, the visible frame, minimized, foreground and front-to-back position |
| `listDisplays()` | every monitor: bounds, work area, scale, primary |
| `snapshot({ windowId })` | one cached subtree request of the window's control view (up to `maxNodes` 400 and `maxDepth` 12 listed, `total` counting the rest; `skeleton` lists only the window, its children and theirs with `childCount` on the containers); each control carries role, name (120 characters), automation id, rectangle, enabled, offscreen, focused, and the patterns it offers (`invoke`, `value`, `toggle`, `expandCollapse`, `selectionItem`, `scroll`) with the value, toggle, expand and selection state |
| `identity` and `resolve` | a fingerprint of a listed control (runtime id, automation id and role, role and a hash of the name with the path of its ancestors, ordinal among equal siblings, process start) and the way back: runtime id, else automation id and role, else role, name hash and path, answering `not_found` or `ambiguous` rather than guessing |
| `seq(windowId?)` and `waitForChange` | events, see below |

### Waiting for a window to settle

`seq(windowId)` returns a marker in the stream of changes and starts watching
that window: accessibility events for its whole subtree (structure changes and
changes to name, enabled, offscreen, toggle, expand, value and selection) and
system window events scoped to its process (windows and controls created,
destroyed, shown, hidden, renamed, valued or moved), so a new top-level window
of the same program counts too. `waitForChange({ windowId, since, quietMs,
timeoutMs })` resolves from those events: once at least one change arrived
since the marker and the window then stayed quiet for `quietMs` (default
120), as `{ changed: true, settled: true, firstEventMs, settledMs, events,
newWindows }`; or `{ changed: false, timedOut: true }` after `timeoutMs`
(default 2 000, at most 10 000) with none. The reply always comes within
`timeoutMs` plus a few milliseconds, and a window that is still changing at the
timeout answers `settled: false`. The marker closes the race between an action
and the wait for its effect:

```text
const since = await backend.seq(windowId)   // also arms the window, once
// ... send the input ...
await backend.waitForChange({ windowId, since })  // counts what the input did, even if it was instant
```

Event handlers only record into a queue; nothing calls back into the
accessibility API from a handler. A marker taken before the helper restarted is
refused (`stale_seq`) rather than misread.

The Windows driver adapter uses this in two places. The window list
(`listWindows`, the one the model sees and the one checked before each window
capture and input) is served from `listWindows({ includeOwned: true })` while the
host is up. The first call after start still goes to the driver, since the host
needs a moment to compile (about 0.4 s), and the host is started when the
adapter is created. A window input takes a marker just before it is sent
(the window is already being watched from its capture), and the host's `settle`
waits from that marker with `quietMs` 120, or the whole budget if that is
smaller, instead of the tool's fixed pause. A marker is dropped when the window is
captured again, so a wait never counts changes a screenshot already showed; a
batch counts from its first input. Display input and the control actions
(`ui_act`) take no marker and keep the fixed pause.

Because the host's rectangle for a window is the visible frame and the
driver's is its own, the check that a window "did not move during a capture"
compares the host's list before and after the capture when the host served
the list, and the driver's `window_bounds` otherwise.

### When it falls back, and the switch

On any failure of the host the driver answers exactly as it did before, in the
same call, without a retry: the first failure pauses the host for 30 s, each
further one doubles that, and after three it is given up on for the session.
A helper that ends is started once more by the next question and then stays off.
`ready()` resolves `false`, never throws, when PowerShell is missing or the
greeting is not the one the client speaks. `settle` answers `undefined`
whenever there is nothing to wait on, which sends the tool back to its fixed
pause. The marker the wait counts from is taken before the action is sent, for
a coordinate input and for `ui_act` on a control alike.

On by default on Windows and WSL when the driver backend is in use. Turn it
off with the host option `a11y: false` (`SubprocessComputerUseHostOptions`) or
the environment variable `NAMZU_COMPUTER_USE_A11Y=off` (`0`, `false`, `no` and
`none` also work).

### Chromium and Electron windows

Reading the accessibility tree of a Chromium or Electron window switches the
accessibility of that whole application on for the rest of its life, which
costs the user speed in a program they did not hand over to be read. `snapshot`
therefore refuses such a window (class `Chrome_*`, a Gecko window, or one that
embeds a Chromium child window) with the error code `chromium_not_activated`
unless the request sets `allowChromium: true`; the check uses window classes,
never accessibility. The window list needs no accessibility at all, and a wait
on one of these windows listens to system window events only.

### What it measured

On a real Windows 11 desktop under WSL (one process, warm unless noted; the
first call after start in brackets; 15 runs, min / median / max in
milliseconds, round trip through the client):

| Call | Cold | min / median / max |
| --- | --- | --- |
| start, compile, first greeting | 385 | n/a |
| `windows` (7 of 484 top-level windows) | 31 | 0.58 / 0.64 / 0.85 |
| `displays` | 1.7 | 0.17 / 0.18 / 0.22 |
| `snapshot` of a terminal window (35 controls) | 72 (67 reading) | 10.1 / 10.4 / 11.1 |
| `snapshot`, skeleton, same window | n/a | 8.0 / 8.3 / 8.9 |
| `snapshot` of a small form (9 controls) | 49 | 21.2 / 21.8 / 22.8 |
| `identity` | 1.7 | n/a |
| `seq(window)`, watching a window for the first time | 250 to 350 for the first window of a run, 150 for the next | 0.36 once watched |

`adapter.listWindows()` through the host: 0.63 / 0.71 ms (median) against 1 300
to 1 750 ms through the driver. Change to answer of `waitForChange`, measured
on an off-screen test form of the measurement's own (20 trials each, the time
from the instant the form changed to the instant the reply was written, 120 ms
of quiet included):

| Change | min / median / max |
| --- | --- |
| a label's text | 130.0 / 131.3 / 145.2 |
| a button enabled or disabled | 130.4 / 131.5 / 132.7 |
| a control added (structure) | 147.3 / 148.3 / 172.6 |
| a second window of the same program opened (reported in `newWindows` each time) | 146.8 / 149.3 / 150.5 |

About 120 ms of each is the quiet time; the rest is how long the accessibility
events take to arrive (about 10 ms for a property, 25 to 30 ms for a new
control or window). A quiet window answers `{ changed: false }` at its
timeout, 403 ms for a 400 ms wait. Against the fixed 500 ms pause this ends
the wait 350 to 370 ms sooner for a window that changes and takes the same
time as before for one that does not. A change that already happened when the
wait starts (the marker was taken before it) is counted: such a wait returns
after 1 to 2 ms.

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
control. A control that had identical twins (same role and name, no id) is found by its stored place only while the whole tree kept its shape; after any change it is `AMBIGUOUS_TARGET`, even when only one twin is left, because which one that is cannot be told. A nameless container is found by its place only while it holds as many children. A `query` snapshot adds refs but records no places for the refs it did not create, a read creates at most 1,000 new refs, and a handle that another program now owns never adopts the old program's refs. A control that lost its patterns is `STALE_REF`. A driver refusal of a token a newer read replaced is not an error
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
