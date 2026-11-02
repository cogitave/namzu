---
'@namzu/computer-use': minor
'@namzu/sdk': patch
---

Selecting a file row in a folder window now selects it and no longer opens it. `ui_act select` on a list or tree row that can also be invoked goes through the row's selection pattern and is verified by reading the row back as selected; where that cannot be reached nothing is sent and the result says a click would open the row. Text typed in the background into a window that was never activated is delivered again (the window's single edit control is used when its thread has no focus window). A caller that relied on `select` opening a file should use `invoke`.


A background input that the window provably did not react to is now sent once more on the screen (through the idle gate, lease and restore) and its result is `sent, no effect seen` and safe to repeat if that also does nothing; a result that said `sent, not confirmed` for such an input before now says so only when the window changed in a way that cannot be tied to the input. A shortcut with a modifier that matches an item of the window's classic menu is carried out as that menu command without pressing a key. `ForegroundMonitor` gains an optional `menuCommand`; a custom monitor is unaffected. A key or mouse button held down now counts as the person using the computer.
