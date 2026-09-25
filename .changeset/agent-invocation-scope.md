---
'@namzu/sdk': minor
---

Managed hosts can now pass tenant, project, topic and session attribution per invocation through `ManagedAgentInput.managedScope` when calling `QueryAgent`. `AgentManager` supplies the admitted child scope itself, and `QueryAgent` accepts that scope while continuing to accept the four flat config fields. If both are supplied with different IDs, the run fails before a model call. The general `AgentInput` and other agent implementations keep their existing contracts. Idempotent `QueryAgent` calls are now deduplicated only within the same managed scope.
