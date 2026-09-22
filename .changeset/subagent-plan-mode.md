---
"@namzu/sdk": minor
"@namzu/cli": patch
---

Plan mode now holds inside delegated work.

`@namzu/sdk`: new optional `BaseAgentConfig.reviewAllowedCalls` and `AgentTaskContext.reviewAllowedCalls`. `AgentManager` stamps the spawning context's function onto every child (after the `configBuilder` runs) and onto the child's spawn context, so grandchildren inherit it too; `SupervisorAgent` hands its own to its workers, and `ReactiveAgent` and `SupervisorAgent` pass it to `query()`. Before, only the turn a host called `query()` with saw `QueryParams.reviewAllowedCalls`: inside a child, a batch a rule allowed, or one an approval earlier in the child's turn covered, ran without reaching the borrowed review handler. Nothing changes for a host that never sets the field. A child config that sets its own value keeps it, but it is OR-ed with the inherited one: a child can ask for more review and can no longer answer `false` over a parent that answers `true`. A host that builds its own `AgentTaskContext` for a `TaskScheduler` should set the field from the function it passes its own `query()`.

`@namzu/cli`: plan mode entered with Shift+Tab while a sub-agent runs now refuses that sub-agent's next change even when a `permissions` rule allows it; before, the child ran it. A paused turn resumed in a session started in plan mode gets the same treatment, for itself and its sub-agents.
