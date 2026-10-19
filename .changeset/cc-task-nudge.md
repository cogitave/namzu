---
"@namzu/cli": minor
---

The model is now reminded of its task list when it has let it go stale. After 10 model turns without `task_create` or `task_update`, and at most once per 10 model turns, it gets a hidden note that the task tools exist, with the list as it stands (`#<id>. [<status>] <subject>`), and is told to ignore it when the work does not call for a list. The counts are read from the conversation, so they survive a resume and start again after compaction. It appears in the interactive terminal only; `namzu exec` and Desktop are unchanged.
