---
'@namzu/cli': minor
---

`Agent` takes an optional `name`. The name then stands in for the task id in `send_message`, `wait_for_task` and `cancel_agent`, and `agent_task_list` shows it. `main`, `team-lead`, `user`, `system` and names shaped like a task or run id are refused. Nothing changes for calls that leave `name` out.
