---
'@namzu/sdk': minor
---

Add `DiskTaskStore.listStrict()` for hosts replacing a complete task projection. It rejects unreadable directories and corrupt records rather than silently presenting an empty or partial list. A session without a task directory still returns an empty list; existing `list()` retains its tolerant behavior.
