---
"@namzu/sdk": minor
---

`FileTaskStore` no longer blocks the thread while it waits for a lock another process holds: it queues this process's changes to one list on a promise and waits for the file lock between tries on the event loop (`lockWait` in its config replaces the wait; a list that stays in use is refused with a `FileLockError` that says so). Callers that only `await` its methods are unaffected. Adds `taskStore` and `taskMember` to `CreateTaskOptions` and `taskMember` to `AgentInput` and `QueryParams`, so one child can work from a shared list under its own member name; unset, nothing changes.
