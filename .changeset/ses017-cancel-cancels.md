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
