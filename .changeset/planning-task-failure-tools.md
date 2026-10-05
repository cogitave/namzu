---
'@namzu/sdk': minor
---

Allow `task_update` to mark a planning task `failed`, matching the existing TaskStore status. Add `stats.failed` to `task_list` and show failures separately in model receipts and operator presentation. Failed blockers stop waiting without being counted as completed; earlier terminal tasks remain excluded from later-turn planning views.
