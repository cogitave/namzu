---
'@namzu/cli': minor
---

A conversation that was reopened, not resumed, now answers the Desktop context panel from its own log. `namzu/session/context` returns the last count the log holds (marked `stored: "record"` on the report, always `approximate`), or an estimate from the stored messages (`stored: "estimate"`) when the model's window is known; it stays `null` when neither exists. `namzu/conversations/history` adds `usage`, `lastTurn` (`completed`, `cancelled`, `failed`, `paused` or `interrupted`, the last meaning the log stops inside a turn) and `environment.cwd`. Both reads start no engine session. Hosts that ignore the new fields see no change.
