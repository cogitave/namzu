---
"@namzu/sdk": major
---

`computer_use` now shows the model a screenshot sized for it and reads every coordinate as a pixel of that screenshot. On a display larger than 1568 px (or 1568 28-pixel patches) the coordinates a caller sends mean something different from before, so this is a major release.

**What changes for a caller of the tool**

- Each capture is fitted to `STANDARD_SCREENSHOT_LIMITS` (Anthropic's standard tier, within OpenAI's `detail: "high"` budget) and numbered `s1`, `s2`, …. `mouse_*`, `scroll` and `zoom` coordinates are pixels of the latest screenshot (or of `screenshot_id`) and are mapped onto the display; a coordinate outside the screenshot is refused. On a display that already fits, the mapping is the identity. To keep host pixels, pass `screenshotLimits` large enough that nothing is resized — but a model will then be sent an image its provider shrinks or rejects.
- Coordinate actions, `type_text` and `key` are refused until the tool instance has taken a screenshot. Call `screenshot` first.
- Results changed shape. An action returns `<label>: done` plus, by default, a new screenshot after 500 ms (`settleMs`, `screenshotAfterActions: false` to turn it off), in `content` with a text block first; `output` is no longer `"ok"`. `cursor_position` returns text in screenshot pixels, not JSON in host pixels. `data` carries `steps` and `screenshot` (`id`, `width`, `height`, `display`).
- `screenshot`, `zoom`, `cursor_position`, `wait` and `list_windows` are now read-only, so a review policy that exempts read-only calls no longer asks before them. Keep asking with an explicit `ask` rule for `computer_use`.
- `ActionInput` gains `zoom`, `wait`, `list_windows`, `focus_window` and `batch`, and an optional `screenshot_id`; code that switches exhaustively over `input.type` needs the new cases.

**New**

- `createComputerUseTool(host, options)` with `screenshotLimits`, `settleMs`, `screenshotAfterActions`, `maxBatchActions` (20), `maxWaitMs` (10 000) and `unavailableReason`.
- `{ type: "batch", actions: [...] }`: checked in full first, run in order, stopped at the first failure (which it names), one screenshot at the end.
- `zoom` (full-resolution crop, through `captureRegion` when the host declares `regionCapture`), `wait`, and `list_windows`/`focus_window` when the host declares `windows`.
- `computerUseUnavailableReason(provider)`: why a provider that cannot put an image in a tool result cannot drive the tool; pass it as `unavailableReason`.
- `screenshotTargetSize`, `STANDARD_SCREENSHOT_LIMITS`, `HIGH_RES_SCREENSHOT_LIMITS` and the types `ComputerUseToolOptions`, `ScreenshotLimits`, `ImageSize`.
- New dependencies `fast-png` and `pica` (pure JavaScript and WASM, MIT; no native build), loaded only when a capture has to be resized.
