---
"@namzu/sdk": patch
---

A turn that only used `task_create`, `task_update`, `send_message` or `stop_task` no longer ends with the verdict "unknown" (the terminal's "A command ran that may have changed files · cannot tell"): those tools write to the task list and the mail between agents, never to the workspace. Any other tool that is not known to be read-only still makes the verdict unknown where the workspace cannot be read.
