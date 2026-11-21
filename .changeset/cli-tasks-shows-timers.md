---
'@namzu/cli': minor
---

`/tasks` now shows the timers the model has set. A new Timers section in the Background dialog lists each pending timer with its prompt and the time left (`↻` marks a repeating one); press `x` on one to cancel it, and the model's timer list no longer shows it. `/tasks list` prints pending timers too. Enter on a timer opens its full prompt and schedule, and a timer set while the dialog is open appears without reopening it.
