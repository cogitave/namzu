---
"@namzu/sdk": minor
---

Add `resumeSessionId` to local child-task admission and expose the admitted conversation as `TaskHandle.childSessionId`. A follow-up keeps the child's conversation and history while creating a fresh task, parent-turn attribution, cancellation channel, budget reservation and current configuration. Existing terminal task handles remain unchanged. Continuation requires a retained capability in the same manager and an unchanged registered definition; replayed history alone cannot authorize execution, and isolated workspaces are refused.

Existing builders supplying a custom log for another session keep their first-invocation behavior. Such a log does not create continuation authority for the admitted child, so a later follow-up is refused instead of replaying unrelated history.

Add optional invocation identifiers to immutable summaries: `SessionSummaryRef.turnRef`, `SessionSummaryMaterializer.materialize({ turnId })`, and `SessionStore.getSummary(sessionId, tenantId, turnId)`. Built-in stores seal follow-up summaries independently without replacing the original conversation summary. Custom session stores enabling continuation must declare `supportsInvocationSummaries: true` and implement this optional invocation key; their existing calls without a turn id retain their behavior.

Continuation also requires `supportsOwnerVersionCas: true`: custom stores must honor the optional expected ownership version on `updateSession` and `recordSummary`. Admission, rollback and pre-invocation checks refuse changed ownership, and `materialize({ expectedOwnerVersion })` prevents an old invocation from idling a new owner during completion. Built-in disk stores serialize these writes within a process; this does not establish a cross-process lease. Calls omitting the version preserve their existing behavior.
