---
type: Design
title: Agent ownership
description: The SDK supplies the execution contract; hosts own agent identity and orchestration.
resource: packages/sdk/src/types/agent/core.ts
tags: [sdk, agents, architecture]
---

# Agent ownership

An application chooses what its agent does. The SDK supplies `runAgent` and
`query` for turns, the `Agent` contract for managed instances, and
`AgentManager` for delegated work. `AgentType` is an application-owned string;
the SDK does not require a reactive, router, pipeline or supervisor kind.
`AgentCapabilities` is descriptive metadata; its booleans do not grant tool
access or enforce a scheduling policy. The provider, toolsets, authorization
gate and manager control those behaviors. A class's `forTurn()` method or a
definition's `createAgent` supplies a separate instance for concurrent spawns.

For a direct turn, call `runAgent`. For a managed instance, implement `Agent`
or call `defineAgent({ type, run, ... })`. The `run` callback receives an
instance-scoped `AbortSignal` as its fourth argument; observe it to stop work
on `cancel()`. `defineAgent` creates a fresh shell for each delegated turn.
`QueryAgent` is an optional adapter when the instance's `run` should execute
one ordinary SDK query. A managed host supplies `{ kind: 'managed', sessionId,
topicId, projectId, tenantId }` as `ManagedAgentInput.managedScope` for that invocation;
`AgentManager` supplies the admitted child session's scope itself, regardless
of caller input. `QueryAgent` requires this complete scope because its query
uses the recorder and checkpoint contracts. The four older fields on
`QueryAgentConfig` remain supported for direct callers; if both forms are
present, they must agree. The general `AgentInput` and other Agent contracts
stay open for application-owned data. General application agents need no scope
unless their own host or storage requires it.
On an existing session log, the supplied scope must also match the owner in
`session_started`. This is checked before the next turn reads history or
touches its budget and topic queue.
`runAgent` also accepts all four optionally and resolves absent values for
its current recorder. Generated labels do not create tenant, topic or project
records and do not grant authority. The host still owns the provider,
toolsets, authorization and cancellation decisions.

The CLI's delegated implementation is `NamzuCliAgent` in
`packages/cli/src/integrations/subagents/`. It derives from `QueryAgent` and
sets its own `namzu-cli` type. Its per-child config is assembled by the CLI.
The top-level CLI turn calls `query()` directly; both paths use the same SDK
kernel without implying that all hosts share one agent class.

`AgentManager.sendMessage` and `TaskScheduler.createTask` accept a per-child
`workspace` choice. `{ mode: 'shared' }` skips workspace provisioning.
`{ mode: 'isolated', backend: 'git-worktree' }` requires a registered Git
worktree driver and runs the child from the new checkout. Before admitting the
child, the manager resolves both filesystem paths and rejects a missing checkout
or one that aliases the caller's directory. `baseRef` optionally
selects its starting commit; otherwise the driver chooses its default. An
optional `subdirectory` starts the child inside that relative path in the
worktree. Admission requires an existing directory whose physical path stays
inside the worktree; `TaskHandle.workspace` still names the worktree root.
`retention: 'retain'` keeps that workspace through completion, failure,
cancellation and later archival, and exposes its ref on the task handle. The
default `retention: 'dispose'` keeps the SDK's existing cleanup policy. Omitting
`workspace` also preserves existing `workspaceBackend` behavior for callers
that already register a backend. A host can set
`AgentManagerConfig.workspaceDefault: 'shared'` to make omitted task choices
share the caller's directory even when a backend is registered; the CLI uses
this setting for its default delegated work. An explicit task `workspace`
choice takes precedence, followed by the legacy `workspaceBackend`, then the
manager default.

`SupervisorAgent`, `PipelineAgent` and `RouterAgent` are worked orchestration
examples under `packages/sdk/src/agents/examples/`. They remain exported for
existing callers, marked deprecated as SDK archetypes. In particular,
`SupervisorAgent` illustrates model-directed task delegation, while the
application decides how its own agent combines delegation with other work.
`ReactiveAgent` remains a deprecated subclass with its old `reactive` type;
its config/result types remain deprecated aliases for the query adapter's
types.

### Continuing a paused supervisor turn

A supervisor turn that ends in `turn_paused` (a provider stream cut with no
retry left) is continued with `SupervisorAgent.resume`, not by running the turn
again, which would repeat tool calls that already had their effect. `resume`
takes what `run` takes plus `{ turnId, checkpointId? }`: it keeps the turn id,
continues from the checkpoint (default the newest, as `resumeSession` chooses),
folds the context from the session log (so `input.messages` is ignored) and
rebuilds the supervisor's delegation, budget and scheduler wiring. `config` must
carry the `sessionLog` the turn was written to. It emits the same `turn_paused`
and terminal events as `run`, so a host bounds its resumes by counting pauses. It
rejects with `invalid_config` when the turn already ended, the checkpoint is
unknown, or the turn waits on a decision `pendingDecision` does not answer.

A stream cut before the provider reported usage leaves its spend unknown, and a
finite `tokenBudget` then refuses further requests until the host reconciles the
ledger (`SessionTokenBudget.reconcileRequest`); the resumed turn would stop with
`token_budget`. A stream that reported usage, or an unlimited budget, resumes.

```ts
import type { AgentInput, SessionEvent, SupervisorAgent, SupervisorAgentConfig } from '@namzu/sdk'

async function runBounded(
	agent: SupervisorAgent,
	input: AgentInput,
	config: SupervisorAgentConfig,
	maxResumes: number,
) {
	let paused: Extract<SessionEvent, { type: 'turn_paused' }> | undefined
	const listener = (event: SessionEvent) => {
		paused = event.type === 'turn_paused' ? event : undefined
	}

	let result = await agent.run(input, config, listener)
	for (let attempt = 0; paused && attempt < maxResumes; attempt++) {
		result = await agent.resume(
			input,
			config,
			{ turnId: result.turnId, checkpointId: paused.checkpointId },
			listener,
		)
	}
	return result
}
```
