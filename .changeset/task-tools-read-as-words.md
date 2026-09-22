---
'@namzu/sdk': patch
---

The planning tools `task_create`, `task_update` and `task_list` now present themselves in words to a host: `Add task · <subject>`, `Start task`, `Complete task`, `Check tasks`, a hidden result view when a call succeeds, and `Tasks · N/M done` for a listing. No presented view carries a task id, an owner or the JSON arguments any more; a host that renders the generic presenter used to show `Task update({"id":"01a0…","status":"completed"})` above `Task 01a0… updated — status: completed`. The model-facing output still names the id it needs. `task_create` and `task_update` add `subject` to their result `data`, and `task_list` says `1 task:` rather than `1 tasks:`. Nothing to change on upgrade unless a host matched the old presented strings.
