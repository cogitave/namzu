---
'@namzu/sdk': minor
---

Make `ToolContext.dispatchTool` an invocation-owned capability: it is revoked when the parent tool settles or is abandoned, and already-started nested calls reach their terminal record before the parent completes. Runs with an `AuthorizationGate` now apply it to nested calls too; denials and calls requiring review fail closed with a durable refusal instead of bypassing operator policy.
