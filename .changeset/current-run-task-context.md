---
'@namzu/cli': major
---

Interactive runs and checkpoint resumes now automatically include a bounded
snapshot of the current run's unfinished tasks in model requests. This changes
the default prompt even when automatic project-memory recall is disabled.
Tasks remain scoped to their run and tenant; new runs do not inherit old plans.

Consumers requiring the previous exact prompt must retain the previous CLI
version or compose an SDK host without this prepare step. SDK defaults and
TaskStore APIs are unchanged.
