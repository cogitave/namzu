---
'@namzu/computer-use': minor
'@namzu/sdk': minor
'@namzu/cli': patch
---

Computer use on Windows stops failing in ways the screen did not show.

A click that the driver refused with `No screenshot frame for window …` no longer reads as `sent, not confirmed`: nothing had been sent. The adapter reads the window again with a screenshot and sends the click once more, and when the window changed size it says `not_delivered`, safe to repeat. A window id is now one number however it is written (`0x2b040a`, `2819082`, a bare number or `{ "hwnd": 2819082 }`), so a read of a window's controls, a screenshot and a click agree on it. An input that reads its place off a screenshot, sent before any screenshot was taken, takes the display screenshot itself and says so in its result, instead of failing with `no screenshot taken yet`. `expand` and `collapse` report `done, verified` only when the window shows what opened and shows it again a moment later; a menu that opened and closed again is `sent, not confirmed`. The tool description tells the model to do on the screen what the person asked to see done on the screen, and to say whether it typed in an application or wrote a file.

`@namzu/computer-use` adds the host option `idleReleaseMs` (default 60 000) and the optional `Adapter.release()`: a host with no call in flight for that long ends its cua-driver process (and the cursor overlay it draws) and the two resident PowerShell helpers beside it (the overlay border and the accessibility host), and starts them again on the next call. `Presence` and `AccessibilityBackend` gain an optional `release()`. Before, every conversation of an app kept its own driver until it closed. `idleReleaseMs: 0` keeps the old behaviour. A ref taken before a release is stale, as after any driver restart; a window screenshot is carried over to the new process by the first input on it, so a pause before a click is not refused. A release that finds a call began meanwhile does nothing.

`@namzu/sdk` tells the model, where the `bash` tool is Git Bash on Windows, to start PowerShell with its script in single quotes or in a quoted heredoc and never in double quotes, where bash expands `$name` first, and to write text files as UTF-8 without a BOM; `@namzu/cli` repeats that in the environment facts. No action is needed to upgrade.
