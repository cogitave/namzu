---
'@namzu/sdk': minor
'@namzu/computer-use': major
'@namzu/cli': minor
---

On Windows, computer use no longer takes the screen from a person who is using it. Input that cannot be delivered in the background (a web page's keys, a covered window, a window that needs real focus, anything sent with `delivery_mode: "foreground"`, display-scope input and `focus_window`) now waits until the user has had no real keyboard or mouse input for 2 s, holds a cross-session lease on the screen, is watched for the user's input while it runs, and afterwards puts back the previous window and pointer, but only if nobody touched input meanwhile.

What changes for the model: a blocked action comes back as "Not delivered" and safe to retry, naming what blocks it (the user is busy, another session holds the screen, the user said no, a lock screen or administrator prompt is in front, the target runs with higher rights). A background action that had to use the screen says so and for how long. If the user presses Escape during one, every later `computer_use` call of that turn returns the same stop message until the next turn. When the user stays busy for 15 s they are asked once whether the application may use the screen for a moment; where nobody can be asked (exec, scheduled runs) the action parks and retries for up to 120 s and then says what blocks it.

What changes for a host: `ComputerUseHost` gains optional `beginTurn(turnId)` and `endTurn()`; `FocusWindowResult` gains optional `delivery`, `retrySafety` and `detail`. All are additive. `SubprocessComputerUseHost` takes `foreground: { approve?, session?, timing? }` and exports `ComputerUseStoppedError`. Breaking default in `@namzu/computer-use` (hence the major): an action that used to reach the screen at once (a display click, `focus_window`, `delivery_mode: "foreground"`) now waits for a still moment and can come back as not delivered; the value that changed is the idle wait before display input and `focus_window`, from none to 2 s; to keep the old behaviour for a script that owns the machine, pass `foreground: { timing: { idleMs: 0, approvedIdleMs: 0 } }`. The CLI asks the one question through its question card.
