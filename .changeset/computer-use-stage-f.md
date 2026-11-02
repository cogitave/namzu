---
'@namzu/computer-use': minor
---

Selecting a file row in a folder window now selects it and no longer opens it. `ui_act select` on a list or tree row that can also be invoked goes through the row's selection pattern and is verified by reading the row back as selected; where that cannot be reached nothing is sent and the result says a click would open the row. Text typed in the background into a window that was never activated is delivered again (the window's single edit control is used when its thread has no focus window). A caller that relied on `select` opening a file should use `invoke`.
