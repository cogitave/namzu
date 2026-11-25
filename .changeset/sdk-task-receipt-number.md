---
"@namzu/sdk": patch
"@namzu/cli": patch
---

On a team's shared task list, the task tools name a task by its number (`#2`, the same count the team's screens use) instead of only its long id. The receipts of `task_create`, `task_update` and `task_get` read `Task #2 (id <id>)` so the model still has the id for its next call, `data.number` carries the number, and `task_list` rows carry it too. A teammate's transcript shows `Task #2 updated — status: completed`. The new `plainTaskReceipt` export removes the id part for a host that draws a receipt as text. A list only one session uses is unchanged.
