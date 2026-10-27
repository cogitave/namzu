---
'@namzu/sdk': minor
'@namzu/cli': patch
---

A step can now keep text in the conversation instead of showing it for one request. `PrepareStepResult.recordedContext` takes `{ key, text }` items; the loop appends each as a history entry (a user-role message whose source is `{ type: 'runtime-context', kind: 'turn-context', key }`) after whatever the history ends with, once, and never edits it. `turnContextEntries(messages, key)` reads what a step already said, so it adds only what is new; `createTurnContextEntry`, `isTurnContextEntry`, `turnContextKey`, `isTurnContextKey` and `lastPromptText` are exported beside it. `createMemoryRecallStep` and `createEvidenceRecallStep` take `record` (default `false`, so their behaviour is unchanged) and `sessionMaxChars` (default 24,000). The CLI turns `record` on and records the repository, file evidence and finished delegated work the same way, so each request begins with the whole of the one before it, across turns, and a caching provider keeps reading the same prefix. The CLI's per-turn text now follows your message instead of coming before it.

What to check when you take this upgrade:

- `'turn-context'` is a new member of `RUNTIME_CONTEXT_MESSAGE_KINDS` and of the `RuntimeContextMessageKind` union. An exhaustive `switch` over the kind stops compiling until it has a case; the new kind is ordinary history, never shown to a person.
- Sessions written from this version on cannot be read by earlier builds, which reject the unknown message kind. A session you open with this version and then open with an older one fails to load in the older one.
- Request-only context (`PrepareStepResult.context`, `context` contributions, the running-task list) now goes at the end of the history instead of ahead of the operator's message. A host that read its position in the request should read the end.
- `CompletionInbox.describeOwnedWork()` is deprecated; the loop reads `describeRunningWork()` and `describeSettledWork()`. The replaceable-block helpers behind the old placement are internal and gone.

The CLI change is wiring only; nothing to change in your configuration.
