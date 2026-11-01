---
'@namzu/sdk': minor
'@namzu/computer-use': minor
---

Computer use on Windows now says "done, verified" for inputs that worked but the driver could not confirm, types into classic text boxes in the background, and puts your window back after it used the screen.

A press, a key or typed text in a window is read back by what the window shows afterwards: typed text that now appears, or a change that followed the input, held still, and was not happening before it, is `done, verified (reads "…")`; nothing observable stays `sent, not confirmed`, and an unrelated change is never taken as the effect. `set_value` on a classic Win32 edit control and `type_text` into a window whose focused control is one are sent as window messages and read back with the control's own text, with no focus change; a program running with higher rights refuses them and the result is `not_delivered` with the reason. A list the driver's value call does not change (a web page's select element) is chosen with the keyboard through the idle-gated foreground ladder and read back, else the result names the browser tool. After a foreground burst the previous window is restored whenever the target took the front, including when Windows refused the helper's own raise, and the result says why when it could not be.

For a host: `WindowInputResult` gains an optional `readBack`, additive. `ForegroundMonitor` gains an optional `editText`; `encodeHelperCommand` now encodes only the bootstrap, and `helperScriptLine` gives the script line written first to the helper. Nothing to change unless you call those directly.
