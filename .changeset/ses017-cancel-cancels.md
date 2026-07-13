---
"@namzu/sdk": minor
---

**Cancel now actually cancels.** Cancelling a run over the wire stopped the agent's status record and nothing else — the agent kept running, and kept spending, until it finished on its own.

The fix is per-run: the caller's abort signal reaches the run through `AgentInput.signal`, which `AbstractAgent.composeRunSignal` already knows how to compose. It is deliberately NOT `agent.cancel()`: an agent instance is shared across runs, and its `abortController` is created once and never reset, so cancelling through it would abort every other in-flight run of that agent and leave the instance permanently aborted — one cancel would kill the agent for the life of the process.

Several cancel paths were lying:

- `SupervisorAgent` children hung off the agent's own controller, which nothing signalled — **children were uncancellable**. They now hang off the run signal, so a cancel cascades.
- `PipelineAgent` never read `input.signal` at all, and a cancelled pipeline reported **failed**. It now composes the signal and reports `cancelled`.
- `AgentManager` marked a cancelled child **completed**, and `dispose()` cancelled nothing (it filtered on an empty run id, which matched no task) while dropping the task map with children still running.
- A cancelled A2A run was recorded **completed**.

The guarantee is honest and stated in the code: the loop stops waiting and stops issuing work. A tool already executing runs to completion — there is no rollback, and none is implied.

A cancelled run is never resumable, by construction: a run whose status is already terminal is refused before it can execute.

**And a cancelled run no longer tells the wire it completed.** `RunEvent` gains **`run_cancelled`**, and it is what a cancelled run emits — on every path: the embedder's `signal.abort()`, the durable `cancelRun`, a reviewer answering `abort`. Previously all of them fired `run_completed` (with an empty `result`), so the run's *record* said `cancelled` while its *event stream* said it had finished. Every client that pairs `run_completed` with "it worked" was told the thing the user cancelled had succeeded. It maps to SSE `run.cancelled` — a wire event that existed in `StreamEventType` from the start with nothing emitting it — and to A2A's `canceled` task state, `final: true`, so a cancelled run can no longer land on A2A `completed`. `PipelineAgent` and `RouterAgent` emit it too; both used to announce a completion for a run they were themselves reporting as cancelled.

A cancel that lands while the run's **last** model call is in flight is now honoured as well. The loop's status re-reads sit at the top of each iteration and before each tool batch, so a cancel arriving after the final one used to be overwritten: the run finished its turn, `markCompleted` stamped `completed` over the `cancelled` the control plane had already written and reported to the caller, and `finalize()` persisted it. The run comes to rest `cancelled`, with no result.

**Breaking for exhaustive consumers**: `RunEvent` gains a variant. A `switch` over `RunEvent['type']` with no `default`, or a mapped type over it (both wire bridges are one), must handle `run_cancelled`. Clients that treated `run_completed` as "terminal, and it worked" now need an arm for the cancellation they were previously being lied to about — and clients that infer terminality from *any* of the three terminal events will simply stop seeing one for cancelled runs.
