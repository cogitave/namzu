---
type: Reference
title: The computer_use tool
description: What createComputerUseTool shows the model and accepts — fitted, numbered screenshots and the coordinate contract, a screenshot after every action, batches, zoom, wait, windows, a window's controls by ref (ui_snapshot, ui_act), read-only classification, asking once per session before the screen is shared, provider gating, and exact per-host action declarations.
resource: packages/sdk/src/tools/builtins/computer-use.ts
tags: [sdk, computer-use, tools, capabilities]
generated: { by: human:bahadirarda, at: 2026-09-24T00:00:00Z }
---

# The computer_use tool

`createComputerUseTool(host, options?)` turns a
[`ComputerUseHost`](computer-use-host.md) into the `computer_use` tool. The
host owns physical pixels and input events; the tool owns everything the
model sees: how big a screenshot is, what a coordinate means, when the screen
is shown again.

## Screenshots and the coordinate contract

A model answers in the pixels of the image it was shown. Send it a native
3440x1440 capture and the provider shrinks it first (Anthropic's API refuses
an oversized computer-use tool result outright; OpenAI's `auto` detail may
pick a 512-pixel view), so every coordinate comes back in a space the host
never saw and clicks land systematically off target.

So every capture is fitted before the model sees it, to the largest
aspect-preserving size within `screenshotLimits`. The size rule is Anthropic's
published reference implementation (`screenshotTargetSize`), ported exactly:
neither side, padded to a multiple of 28, above `maxLongEdge`, and no more
than `maxTiles` 28-pixel patches.

| Limits | Long edge | Patches | 3440x1440 becomes | 1920x1080 becomes |
| --- | --- | --- | --- | --- |
| `STANDARD_SCREENSHOT_LIMITS` (default) | 1568 | 1568 | 1568x656 | 1456x819 |
| `HIGH_RES_SCREENSHOT_LIMITS` | 2576 | 4784 | 2576x1078 | unchanged |

The standard limits are taken unchanged by every current vision model: they
are Anthropic's standard tier, and inside OpenAI's `detail: "high"` budget
(2048 px, 2 500 32-pixel patches). Choose the high-resolution limits only when
every model the session can reach is on Anthropic's high-resolution tier
(its 4.7 and later models): a standard-tier model rejects such an image in a tool
result, OpenAI shrinks anything over 2048 px, and a request carrying more than
20 images caps each at 2000 px.

Each screenshot is numbered (`s1`, `s2`, …) and its tool result starts with
one line of text before the image:

```text
Screenshot s3: 1568x656 pixels, showing the 3440x1440 display. Send coordinates in this image's pixels (x 0–1567, y 0–655); the tool maps them onto the display.
```

Every x/y the model sends is a pixel of the latest screenshot (or of the one
named in `screenshot_id`), never a screen pixel. The tool maps image pixel
`x` to display pixel `floor((x + 0.5) × displayWidth / imageWidth)` — the
centre of the area that pixel showed — and the reverse mapping returns the
same image pixel, so a click lands within one screenshot pixel of what the
model saw. A coordinate past the image's far edge is refused, not clamped:
it was read off some other image, and acting on it would click somewhere the
model never looked. Before the first screenshot, actions that take
coordinates, and `type_text` and `key` (which go to whichever window has
focus), are refused with "take a screenshot first". `cursor_position` reports
in screenshot pixels.

The latest screenshot's size is also pinned into the turn's working memory
(`computer_use.screenshot`), so it survives compaction when older images are
cleared.

The PNG work uses [`fast-png`](https://github.com/image-js/fast-png) and
[`pica`](https://github.com/nodeca/pica) (Lanczos-3, pure JavaScript with a
bundled WASM kernel; both MIT), loaded only when a capture has to change size.
Neither needs a native build. A 3440x1440 capture takes about 190 ms to
decode, resize and encode; one that already fits is passed through untouched.

## A screenshot after every action

An action that changes something — a click, a drag, a scroll, typing, a key,
`focus_window` — and `wait` return a new screenshot after `settleMs` (500 ms
by default), so the model does not spend a round trip asking for one.
`screenshotAfterActions: false` turns this off. If only that screenshot fails,
the action still reports success and the text says to take one.

## Actions

| Action | Fields | Returns a screenshot |
| --- | --- | --- |
| `screenshot` | — | itself |
| `zoom` | `region: { x, y, width, height }` | a closer view, not a new coordinate space |
| `cursor_position` | — | no |
| `mouse_move` | `to` | yes |
| `mouse_click` | `at`, `button` (left when omitted) | yes |
| `mouse_drag` | `from`, `to`, `button` (left when omitted) | yes |
| `scroll` | `at`, `direction`, `amount` | yes |
| `type_text` | `text` | yes |
| `key` | `keys` | yes |
| `wait` | `ms` (at most `maxWaitMs` per call, 10 000 by default; a batch's waits share it) | yes |
| `list_windows` | — | no |
| `focus_window` | `window_id` | yes |
| `ui_snapshot` | `window_id` (optional; the window in front without it) | no — the window's controls as text |
| `ui_act` | `ref`, `action`, `value` (for `set_value`) | yes |
| `batch` | `actions` | one, at the end |

Every action also takes an optional `screenshot_id`.

`zoom` crops the region at full physical resolution (through
`captureRegion` when the host declares `regionCapture`, otherwise from a
fresh full capture) and fits the crop to the same limits without enlarging
it. Its text says the coordinates still refer to the screenshot it was taken
from; zoom never starts a new coordinate space.

`list_windows` and `focus_window` are offered only when the host declares
`windows` and implements both methods. The list gives each window's id,
title, application, pid, focus and where it sits on the latest screenshot,
inside an untrusted-content frame (`<namzu-untrusted kind="desktop-windows">`):
a title is whatever the application shows, a web page's title in a browser
window included. `focus_window` fails when the window in front afterwards is
not the one asked for, and says which one is.

## A window's controls

When the host declares `uiTree` and implements `uiSnapshot` and `uiAct`,
the tool offers `ui_snapshot` and `ui_act`, and tells the model to prefer
them to pixel clicks when a control is in the tree: they do not depend on
coordinates or on which window is in front, and several `ui_act` steps fit
in one batch.

`ui_snapshot { window_id }` reads one window's accessibility tree and shows
it as indented text, one control per line:

```text
UI snapshot u2 of window 0x3c40f70: 51 controls shown, 36 with a ref you can pass to ui_act. Refs are valid until the next ui_snapshot.
@(x, y) is a control's centre on screenshot s2, for a click when ui_act cannot reach it.
<namzu-untrusted kind="desktop-ui" window="0x3c40f70">
…
Application "ApplicationFrameHost"
Window "Hesap Makinesi"
  Text "İfade değeri 125 × 8="
  [e43] Text "Ekran değeri 1,000" [invoke] @(81, 71)
  [e65] Button "Beş" [invoke] @(64, 188)
  [e72] Button "Sıfır" (disabled) [invoke] @(64, 236)
</namzu-untrusted>
```

- Only a control the host can act on gets a ref. Refs count up across
  snapshots (`e1`…`e36`, then `e37`… in the next), so a ref from an earlier
  snapshot is refused ("not a control of the latest ui_snapshot (u2)")
  instead of silently naming whatever holds that number now.
- A nameless control nothing can be done with is left out and its children
  move up a level. Names and values are cut to one line of 64 characters.
- `@(x, y)` is the control's centre on the latest screenshot, for the rare
  control `ui_act` cannot reach; there is none before the first screenshot.
- Everything the application wrote sits inside an untrusted-content frame;
  the header, refs and positions are the tool's. A name cannot close the
  frame early.
- The text is cut at 14 000 characters (about 4 000 tokens), with a line
  saying how many controls were shown out of how many; a host that stopped
  its own walk sets `truncated` and the text says so.

`ui_act { ref, action, value }` acts on one control: `invoke` (press a
button, open a menu item), `set_value` (replace a field's text with `value`),
`toggle`, `select`, `expand`, `collapse`, `focus`, `scroll_into_view`. An
action the control does not list, or `set_value` without `value`, is refused
before anything runs; in a batch that refuses the whole batch. The host's
refusal comes back in its own words (`that control is from an older UI
snapshot; take a new one`). Like every action that changes something, it
returns a screenshot afterwards.

`ComputerUseTool.describeUiRef(ref)` (experimental) names the control a ref
points at in the latest snapshot — `Button "Beş" (e65)` — for a host that
shows a person the call before it runs; the activity line uses it too
(`6 desktop actions: Press Button "Bir" (e25) · …`).

## Batches

`{ "type": "batch", "actions": [...] }` runs up to `maxBatchActions` (20)
actions in order and returns one screenshot at the end. Every action is
checked first — capability, button, a coordinate on the screenshot — and a
batch with one bad action runs none of them. At run time it stops at the
first action that fails and reports which:

```text
Batch stopped at action 2 of 3; 1 not run.
1. Click left at (700, 300): done
2. Type "hello": failed — SendInput returned 0
3. Press ENTER: not run
Screenshot s5: 1568x656 pixels, …
```

The description tells the model that every call costs a round trip and to
batch the steps it can already predict, but to end a batch at any step that
should bring up a new window and look before typing into it. On a Windows
host it says a shell command is the surest way to start a program: the Start
menu matches display names in the system language and turns an unmatched
`ENTER` into a web search in the browser (on a Turkish Windows a model typed
"Calculator" into Start and opened Bing in the operator's Edge). With
`uiTree`, the first screenshot's text points at `list_windows`, `ui_snapshot`
and `ui_act`.

## Nothing is typed into a terminal

With a host that lists windows, `type_text` and `key` read the window in
front first and refuse — before anything is sent — when it is a terminal
(`WindowsTerminal`, `conhost`, `cmd`, `powershell`, `pwsh`, `mintty`,
`wezterm`, `alacritty`, `kitty`, `iTerm2`, `Terminal`, `gnome-terminal`,
`konsole`, `xterm` and the like, by `WindowInfo.app`): that is usually the
terminal running the agent or one the user is typing in, and `ENTER` there
runs or sends whatever was typed. The read happens before the first keyboard
step of a call and again after any step other than typing that may have moved
focus, so a batch that focuses Notepad and types into it reads the front
once. In a real session a batch of `WIN+R`, `notepad`, `ENTER` ran while the
user's own terminal was in front and the Run dialog did not open: the letters
and the `ENTER` went into that terminal and submitted the half-written
message there. The model is told to bring the window it means to the front
first, or to use a shell for commands. A host without a window list cannot
say what is in front, and only the description's advice applies.

The screenshot is still taken when an earlier action changed the screen or
the failed one's outcome is unknown. A batch cannot contain `screenshot`,
`zoom`, `ui_snapshot` or another batch; all its coordinates refer to the screenshot current
when it starts (or `screenshot_id`). A cancelled turn stops the batch between
actions.

## Classification and presentation

`screenshot`, `zoom`, `cursor_position`, `wait`, `list_windows` and
`ui_snapshot` are read-only, as is a batch made only of them; anything else is
not. `mouse_click`, `mouse_drag`, `scroll`, `type_text`, `key` and `ui_act`
are destructive, and a batch is destructive when any of its actions is.
`mouse_move` and `focus_window` are neither.

The tool also declares which calls send the screen to the model provider
(`ToolDefinition.capturesScreen`): `screenshot`, `zoom`, `list_windows` and
`ui_snapshot`, and every action that returns a screenshot afterwards (all but
`cursor_position`, unless `screenshotAfterActions` is off). A tool mounted as
a diagnostic declares none.

## Sharing the screen: asked once per session

A screenshot changes nothing, so every rule that approves reads would let it
run unasked — and it is the one read that sends whatever is on the screen,
the operator's mail and chats included, to the model provider.
`createReviewHandler` takes a consent record, `screenConsent: { sessions }`,
and a `capturesScreen(name, input)` predicate (default: the tool's own
declaration, read from `registry`). With them, the first batch in a session
holding a call that captures the screen is put to a person as a
`ToolReviewRequest` with `screenConsent: true`, even when it only reads:

| Mode | First screen capture in a session | Later ones |
| --- | --- | --- |
| `prompt`, `accept-edits` | asked once | run as the reads they are |
| `plan` | asked once; refused when nobody can be asked | run; clicks and typing are still refused |
| `strict` | refused unless a rule allowed the call | refused unless a rule allowed the call |
| `auto` | not asked | not asked |

A yes adds the session id to `sessions` and also answers that batch: nobody
is asked twice for one batch. A no refuses the batch with
`SCREEN_CONSENT_DECLINED_FEEDBACK`; with no person to ask the batch is
refused with `SCREEN_CONSENT_UNATTENDED_REFUSAL`. A call a rule allowed is
never asked about — but the gate's read-only rule (`allowReadOnlyTools`) steps
aside for a call that captures the screen, so the first screenshot reaches the
policy instead of running unasked. Clicks, typing and `ui_act` keep being
reviewed as before.
The host keeps one record for as long as its sessions live, so a mode switch
keeps the answer and a new session is asked again.

A call is presented as one activity line (`Click left at (812, 403)`;
a batch as `3 desktop actions: Click left at (812, 403) · Type "…" · Press ENTER`).
A successful action's result row is hidden — the call row already says it —
while screenshots, zooms, window lists and failures stay visible.

## Providers that cannot show the model a screenshot

The screenshot reaches the model only as an image in a tool result. A driver
that declares `supportsToolResultImages: false` (OpenAI Chat Completions,
Bedrock, OpenRouter, LM Studio, Ollama and the generic HTTP driver today)
would replace it with a line of text while every click reported success.
`computerUseUnavailableReason(provider)` returns why such a provider cannot
drive the tool, and passing that as `options.unavailableReason` mounts the
tool as a diagnostic: its description says why and every call is refused
without touching the host. An undeclared capability keeps the permissive
default.

The Codex (OpenAI Responses) driver sends tool-result images with
`detail: "high"` instead of `auto`, which could pick the 512-pixel `low`
view. `high` is accepted by every Responses model and keeps an image within
2048 px and 2 500 patches at its own size; `original` would too, but only
gpt-5.4 and later accept it. User attachments keep `auto`.

## In the namzu CLI

The interactive session checks its provider before it starts the desktop
host. With a provider that cannot carry tool-result images, `computer_use` is
mounted unavailable, the host is never initialised, and the session notices
say `Computer use is unavailable in this session: …`. The check reads the
first provider of the chain.

A reviewed `computer_use` call lists its actions one per line, in order, with
the text to be typed shown whole, the screenshot the coordinates belong to,
and for `ui_act` the control by the name its application gives it
(`Press Button "Beş" (e65)`, from `describeUiRef`); an action or field the
formatter does not know opens the exact view first.

In `prompt`, `accept-edits` and `plan` the first screen capture of a session
opens a box titled `Share your screen`: `namzu will see your screen and send
it to <provider> for this session: screenshots, the titles of open windows
and the controls of the windows it reads.` The answers are `Yes, share my
screen for this session` and `No, and tell namzu what to do differently`;
there is no "allow all tools" on it, and an "allow all" given on another
prompt never settles it. The answer lasts until the session ends: a mode
switch keeps it, `/new`, `/clear` or `/model` (a new session or provider)
ask again. The box is the SDK's consent request; the record is kept by the
interactive session (`packages/cli/src/tui/agent.ts`).

## Host action declarations

`ComputerUseCapabilities.supportedActions` optionally declares an exact action
subset. It refines the broad screenshot, mouse, keyboard and cursor flags;
it cannot enable a disabled broad capability. An absent subset preserves the
existing broad-flag interpretation for custom hosts, while an empty subset
means no action is available. `zoom` and `wait` follow `screenshot`, and
`batch` is offered when any action it may carry is.

`mouseClickButtons` and `mouseDragButtons` optionally restrict each gesture's
buttons separately. Empty button lists disable that gesture. Missing lists
leave button validation to the host. Shipped adapters freeze their action lists
after probing; availability still depends on OS permissions and a live desktop.

The model schema is one flat object (no root `anyOf`, which some custom-tool
wires reject) listing only the available actions, with the batch items'
action list narrowed the same way. The runtime schema still understands every
action, so an unsupported call receives a capability error. A wholly
unavailable host retains the general schema for diagnostic calls, avoiding an
invalid empty enum on provider transports, and refuses all execution.

| Adapter | Action limits |
| --- | --- |
| Windows / WSL | Screenshot, cursor, move, click, drag, scroll, text and keys, every button. With the cua-driver backend also `windows` (list and focus) and `uiTree` (UI Automation); no region capture. |
| X11 | Screenshot depends on maim; input and cursor depend on xdotool. |
| Wayland | Screenshot depends on grim; mouse actions on ydotool; keyboard on wtype or ydotool. Cursor position is unavailable. Daemon permissions are checked by the underlying operation, not established by binary detection. |
| macOS | Screenshot (main display, physical pixels) and keyboard use system tools. Move, drag and cursor require cliclick; scroll is unavailable. Without cliclick only left clicks are supported; with it left/right clicks are supported. Drag supports only the left button. Pointer coordinates are converted from the capture's pixels to points at the adapter, so a Retina click lands where the screenshot showed. |

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

| Backend | Actions | `windows` | `regionCapture` | `uiTree` | Buttons |
| --- | --- | --- | --- | --- | --- |
| cua-driver | all eight | `true` | `false` | `true` | left, right, middle for click and drag |
| PowerShell | all eight | absent | absent | absent | not declared (all three work) |

The UI tree comes from cua-driver's `get_window_state` (a UI Automation walk
of one window, at most 1 500 controls, no screenshot): its structured records
for the controls it can act on, and its indented text for everything else, so
a calculator's expression line and a status bar's text are in the tree too.
A control's ref is cua-driver's element token, which names its snapshot; the
adapter keeps only the latest snapshot's. `invoke`, `toggle`, `select`,
`expand` and `collapse` go through cua-driver's `click` on the token — UI
Automation's Invoke in the background, with no pointer move and no change of
foreground; `set_value` through `set_value`, and, for a field that reports no
settable value (classic Notepad's editor), by typing into it when it is empty.
Such a field that already holds text is refused, since typing would add to
it. `focus` and `scroll_into_view` are not offered. A background Invoke
reports its effect as unverifiable by design; the screenshot the tool takes
afterwards is where the model sees it.

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
7. Open Calculator and `uiSnapshot` its window: the buttons carry refs, the
   expression and result lines are in the tree. Invoke 1, 2, 5, ×, 8, = by
   ref (about 90 ms for the six, the window never brought to the front) and
   snapshot again: the result reads `1,000`; a ref from the first snapshot is
   refused as stale. Invoke its Close button by ref: the process exits.
8. In a fresh Notepad, `set_value` the editor to `Merhaba dünya ığüşöç İĞ`:
   `set_value` reports no ValuePattern, the adapter types instead, and the
   next snapshot's value is identical.

These declarations do not add browser element references, remote desktop
allocation or human-control handover. Those remain separate capabilities in
the [framework audit](framework-gap-audit.md).
