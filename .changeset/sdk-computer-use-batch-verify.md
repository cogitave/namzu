---
"@namzu/sdk": minor
---

`computer_use` batches that only press controls (`ui_act`, `ui_do`) or type and press keys in a window whose controls you have read now end with that window's controls as a diff and no screenshot; take a `screenshot` yourself if you need the picture, or pass `screenshot_id`. A click, drag or scroll on a window screenshot is refused (nothing sent, safe to retry) when the window has moved, been resized, minimized or closed since that screenshot. A pixel action that leaves the picture identical now reports "No visible change" (`data.noVisibleChange`), and an action that closed its window reports it (`data.windowClosed`) rather than failing the follow-up screenshot. A host that implements `listWindows` is now asked for the window list before each window-scoped pixel action.
