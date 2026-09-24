---
type: Reference
title: The computer_use tool
description: What createComputerUseTool shows the model and accepts — fitted, numbered screenshots and the coordinate contract, a screenshot after every action, batches, zoom, wait, windows, read-only classification, provider gating, and exact per-host action declarations.
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
| `mouse_click` | `at`, `button` | yes |
| `mouse_drag` | `from`, `to`, `button` | yes |
| `scroll` | `at`, `direction`, `amount` | yes |
| `type_text` | `text` | yes |
| `key` | `keys` | yes |
| `wait` | `ms` (at most `maxWaitMs` per call, 10 000 by default; a batch's waits share it) | yes |
| `list_windows` | — | no |
| `focus_window` | `window_id` | yes |
| `batch` | `actions` | one, at the end |

Every action also takes an optional `screenshot_id`.

`zoom` crops the region at full physical resolution (through
`captureRegion` when the host declares `regionCapture`, otherwise from a
fresh full capture) and fits the crop to the same limits without enlarging
it. Its text says the coordinates still refer to the screenshot it was taken
from; zoom never starts a new coordinate space.

`list_windows` and `focus_window` are offered only when the host declares
`windows` and implements both methods. The list gives each window's id,
title, application, pid, focus and where it sits on the latest screenshot.
`focus_window` fails when the window in front afterwards is not the one
asked for, and says which one is.

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

The screenshot is still taken when an earlier action changed the screen or
the failed one's outcome is unknown. A batch cannot contain `screenshot`,
`zoom` or another batch; all its coordinates refer to the screenshot current
when it starts (or `screenshot_id`). A cancelled turn stops the batch between
actions.

## Classification and presentation

`screenshot`, `zoom`, `cursor_position`, `wait` and `list_windows` are
read-only, as is a batch made only of them; anything else is not.
`mouse_click`, `mouse_drag`, `scroll`, `type_text` and `key` are destructive,
and a batch is destructive when any of its actions is. `mouse_move` and
`focus_window` are neither.

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
