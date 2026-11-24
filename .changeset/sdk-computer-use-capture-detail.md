---
'@namzu/sdk': minor
---

`computer_use` no longer steers the model to `zoom` and no longer asks for a screenshot before the first pixel click (the screenshot an action returns is enough). The display-shrink sentence now points at a window screenshot instead of `zoom`. `screenshotLimits` on `createComputerUseTool` also accepts a function, asked before every capture, and the new `screenshotLimitsForModel(model)` returns the high-resolution tier for Anthropic's 4.7 and later models and the standard tier for everything else. Nothing to change on your side; pass `screenshotLimits: () => screenshotLimitsForModel(model)` to size captures by model.
