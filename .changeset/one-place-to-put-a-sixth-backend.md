---
'@namzu/sdk': patch
---

Internal move: `RemoteExecutionContext`, `HybridExecutionContext` and `ExecutionContextFactory` move from `connector/execution/` to `execution/`, joining `BaseExecutionContext` and `LocalExecutionContext`. No exported name, signature or behaviour changes, and no consumer import path changes — `connector/index.ts` re-exports the whole group from the new home.

One concept sat in two directories, and `connector/index.ts` reached into both to reassemble a single public export group. A contributor adding a fifth backend had no principled place to put it, and either answer was defensible from where they stood.

Consolidated upward rather than down: `run/command-gate.ts` imports `LocalExecutionContext` directly, so execution is not connector-scoped. A connector is one *caller* of an execution context, not the thing that defines one.
