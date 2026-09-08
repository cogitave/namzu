---
type: Reference
title: Tool execution ordering
description: Opt-in batch barriers, concurrency, cancellation and nested dispatch ordering.
resource: packages/sdk/src/runtime/query/executor.ts
tags: [sdk, tools, execution]
status: stable
---

# Tool execution ordering

`ToolDefinition.executionBarrier` and `defineTool({ executionBarrier: true, ... })`
opt a tool into ordering within a direct model tool-call batch. All earlier calls
settle before the barrier starts, and later calls wait for the barrier to settle.
Results remain in the model's original call order. For `[read, read, write,
read, read]`, making `write` a barrier lets each pair of reads overlap while
ensuring the second pair sees a successful completed write.

The default is absent/false. `concurrencySafe: false` still serializes a tool
against other unsafe calls; concurrency-safe calls may overlap that chain.
`concurrencySafe: true` still permits bounded parallel execution between barriers.
A barrier takes precedence over either concurrency setting. SDK builtins keep
their existing defaults; hosts can register `{ ...tool, executionBarrier: true }`
to opt selected mutation tools into ordered verification. Wrappers and registry
copies must retain this metadata.

A barrier orders settlement, not success. Failed, denied and recovered calls
retain the boundary; subsequent calls can inspect unchanged or partial state.
Unexpected executor/host rejection prevents dependent execution. Cancellation
before a queued call starts prevents its tool body from running. Each execution's
deadline starts when it executes, excluding time waiting behind a barrier.
Existing deadline abandonment still applies: a tool ignoring its abort signal
may continue external effects after its timeout result. Barriers provide no
rollback or guarantee that an uncooperative operation has stopped.

The scope is one direct batch, not a global lock across runs. Nested dispatches,
including `run_code` calls, belong to the enclosing execution and are not queued
on the enclosing batch's barriers. The enclosing executor closes and drains
admitted nested dispatches before reporting settlement. Mark the enclosing tool
as a barrier to isolate it from direct siblings. Inside a program, explicitly
`await` a mutation before dispatching dependent reads; a nested tool's barrier
metadata does not turn `Promise.all` into a sequential program.
