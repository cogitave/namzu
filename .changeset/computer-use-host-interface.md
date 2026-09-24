---
"@namzu/sdk": minor
---

`ComputerUseHost` can now describe the display it captured and offer window and region operations. Everything is additive and optional, so an existing host compiles and behaves as before.

- `ScreenshotResult.display` (`DisplayInfo`: `id`, `x`, `y`, `width`, `height`, `scaleFactor`, `primary`) says which display a capture shows. Set it in a host you maintain; without it the SDK assumes one display at the origin, the size of the capture, at scale factor 1.
- The contract is now written down as physical pixels everywhere: action points are relative to the display last captured, window bounds are virtual-desktop pixels. A host that clicks in logical units (points, or a DPI-unaware process) must convert at its own boundary.
- Optional methods `listWindows()`, `focusWindow(id)` and `captureRegion(rect)` are used only when the new capability flags `windows` and `regionCapture` are `true`. `uiSnapshot()`/`uiAct()` behind `uiTree` are experimental and may change in a minor release.
- New exported types: `DisplayInfo`, `Rect`, `WindowInfo`, `FocusWindowResult`, `UiElement`, `UiElementAction`, `UiSnapshot`, `UiActResult`.
