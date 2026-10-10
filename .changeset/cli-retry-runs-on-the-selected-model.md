---
"@namzu/cli": minor
---

`namzu acp --desktop`: `namzu/sessions/retry-status` adds two optional fields, `closable: true` (the paused turn stopped on a provider failure and waits for no decision, so `namzu/sessions/abandon-paused` may close it before a new message) and `retry.original` (`{provider, model}` that stopped). `namzu/sessions/retry` now runs the paused turn on the model the conversation has selected, not on the model that failed, and no longer refuses when the provider differs; the approval settings the turn began under are kept across a model change. A client that ignores the new fields behaves as before, except that a retry after choosing another model now runs on that model instead of being refused.
