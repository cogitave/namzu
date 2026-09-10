---
"@namzu/cli": minor
---

Retain session-scoped agent receipts across CLI restarts. Resumed conversations receive a bounded summary of earlier tasks; `agent_task_list` accepts `history: true` and an optional `task_id` to inspect saved outcomes and result previews without launching another agent. Tasks without a terminal receipt remain explicitly unresolved, not falsely running or completed. This does not automatically restart child processes.
