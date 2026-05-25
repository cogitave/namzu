---
'@namzu/cli': minor
---

**The agent can track a plan with the SDK task system (todo-style).**

namzu now passes a `DiskTaskStore` to the agent loop, which auto-registers the SDK's `task_create` / `task_update` / `task_list` tools. The model can lay out and track a multi-step plan for the current request (like Claude Code's todos): new tasks appear as `☐ <subject>` and completed ones as `☑ <subject>` in the transcript. Tasks are scoped to the request.
