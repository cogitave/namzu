---
'@namzu/sdk': minor
'@namzu/computer-use': minor
---

Computer use on Windows now stops when you interrupt it, says plainly when an administrator window swallowed its typing, and refuses to act on a locked computer.

Interrupting a turn (Esc) ends a pending desktop action at once instead of waiting for the driver: an action that may already have been sent is reported as sent, not confirmed and unsafe to repeat, one that was not sent yet as not delivered and safe, and the window and pointer it borrowed are put back only after the driver has stopped acting. When a window running with higher rights is in front, input sent from here is dropped by Windows without any error; Namzu now detects that (the window's integrity level beforehand, and whether the system registered the input afterwards) and reports "An administrator window is in front; Namzu cannot type into it" as not delivered and safe to repeat. A locked computer (lock screen, sign-in screen or a secure prompt) is refused before anything is read or sent, and a screenshot taken while it locked is discarded. The desktop driver's own cursor is switched off so only Namzu's is shown.

For a host: every desktop-reaching `ComputerUseHost` method (`execute`, `listWindows`, `focusWindow`, `captureWindow`, `executeWindow`, `captureRegion`, `uiSnapshot`, `uiAct`) gains a trailing optional `signal?: AbortSignal`, additive; a host that ignores it keeps working. `MonitorState` gains optional integrity fields, `MonitorBurstEnd` gains optional `inputMoved` and `frontElevated`, and `@namzu/computer-use` exports `ComputerUseLockedError`. Nothing to change unless you implement a host or a foreground monitor.
