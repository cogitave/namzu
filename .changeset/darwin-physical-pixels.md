---
"@namzu/computer-use": patch
---

On macOS, clicks, moves, drags and the cursor position now use the same physical pixels as the screenshot. A Retina capture is twice the size of the screen in points, and the adapter used to hand pixel coordinates to `cliclick` and System Events unchanged, so a click aimed at the middle of a screenshot landed near the bottom-right corner. Screenshots also report their `display` (size and scale factor) and capture the main display only. No change is needed on your side.
