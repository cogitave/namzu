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
`QueryAgent` is an optional adapter
when the instance's `run` should execute one ordinary SDK query. Its config
currently requires the caller's tenant, project, topic and session identity
because it passes a managed turn into the recorder and checkpoint contracts.
Those IDs are host storage and correlation scope, not properties every
application agent must own. `BaseAgentConfig` keeps them optional; a
store-backed `AgentManager` supplies real scope to delegated turns.
`runAgent` also accepts all four optionally and resolves absent values for
its current recorder. Generated labels do not create tenant, topic or project
records and do not grant authority. The host still owns the provider,
toolsets, authorization and cancellation decisions.

The CLI's delegated implementation is `NamzuCliAgent` in
`packages/cli/src/integrations/subagents/`. It derives from `QueryAgent` and
sets its own `namzu-cli` type. Its per-child config is assembled by the CLI.
The top-level CLI turn calls `query()` directly; both paths use the same SDK
kernel without implying that all hosts share one agent class.

`SupervisorAgent`, `PipelineAgent` and `RouterAgent` are worked orchestration
examples under `packages/sdk/src/agents/examples/`. They remain exported for
existing callers, marked deprecated as SDK archetypes. In particular,
`SupervisorAgent` illustrates model-directed task delegation, while the
application decides how its own agent combines delegation with other work.
`ReactiveAgent` remains a deprecated subclass with its old `reactive` type;
its config/result types remain deprecated aliases for the query adapter's
types.
