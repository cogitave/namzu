---
"@namzu/sdk": minor
---

Adds `FileTaskStore` (`@experimental`), a task list that several processes share under `<NAMZU_HOME>/tasks/<list id>/`: each change runs under lock files, `claimTask` says `not_found`, `already_claimed`, `already_resolved` or `blocked` so exactly one claimer wins, dependencies are kept in both directions and a cycle is refused, and a task is blocked only until its blockers are completed. `buildTaskTools` over such a store also adds `task_get`, makes `task_update` to `in_progress` a claim under the new optional `member` of its scope, and lists every task of the list. Over `InMemoryTaskStore`, `DiskTaskStore` or any custom store nothing changes; callers that do not use `FileTaskStore` are unaffected.
