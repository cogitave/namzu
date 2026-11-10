---
'@namzu/computer-use': minor
---

On Windows, a keyboard-and-mouse helper that has stopped no longer takes the screen path down for the rest of the session. A helper that ended is replaced before the next use; a run whose first look or start fails because the helper died is repeated once with a fresh helper, and a start that fails is retried once. After two failed starts in a row the failure is remembered until the turn ends, so the model is not charged a PowerShell compile per retry. If the helper dies in the middle of an action, that action fails with "the keyboard-and-mouse helper stopped during the action" and is not restarted inside itself.

The `monitor_unavailable` message now names the cause (could not start PowerShell, exit code and last error line, or a blocked compile with the PowerShell language mode) instead of "the Windows helper exited". It no longer tells `ui_act` callers to use `ui_act`: those paths say the control could not be pressed in the background and to try another control or ask the user, while display and window actions still say controls by ref work.

Nothing breaks for existing callers. `ForegroundMonitor` gains an optional `running` member (a custom monitor that leaves it out is treated as always running; return `false` once yours can no longer answer to have it replaced), `ForegroundBlock` gains an optional `reason`, and `HelperProcess.onExit` handlers may now receive `{ code, signal, stderr, spawnError }`; a handler that ignores its argument keeps working.
