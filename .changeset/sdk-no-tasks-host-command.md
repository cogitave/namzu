---
"@namzu/sdk": major
---

`kernelHostCommands()` no longer returns a `tasks` command, and its options no longer accept `taskStore`. The command listed the model's task checklist; a host that dispatched `/tasks` through the registry now gets no outcome for that name, so a host that wants the checklist reads its own task store (`TaskStore.list()`) and draws it. `/tasks` is now free for a host to use for its own meaning (the CLI uses it for the background tasks view). The `agents`, `goal` and `skills` commands are unchanged. `query()`'s `taskStore` option and the task tools are unchanged.
