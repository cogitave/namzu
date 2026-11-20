---
'@namzu/cli': minor
---

The model can now set timers and pace its own loops. `timer_set` fires a prompt into the open conversation once or on a schedule (no review; memory only, gone when the session closes; at most 50; recurring ones end after 7 days; fires only between turns and says what fired). `/loop <prompt>` with no interval, or `session_loop` without one, starts a self-paced loop: the model chooses each next wake-up (a minute to an hour), `/loop list` shows when and why, and runs of quiet ticks print one line. Nothing to do: `/loop 10m ...` and `schedule` work as before, and a `/loop` whose first word is not an interval is now a self-paced loop instead of an error.
