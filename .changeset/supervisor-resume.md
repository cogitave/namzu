---
"@namzu/sdk": minor
---

`SupervisorAgent.resume(input, config, { turnId, checkpointId? }, listener?)` continues a turn that ended in `turn_paused`: the same turn id, from the chosen checkpoint (default the newest), with the context folded from the session log. Tool calls that already ran are not repeated. It rebuilds the delegation, budget and scheduler wiring the way `run` does and emits the same `turn_paused` and terminal events, so a host can bound how often it resumes. Pass the `sessionLog` (and `checkpointStore`, if it is not the one beside the log) the turn was written to. It rejects with an `invalid_config` `NamzuError` when the turn already ended, has no such checkpoint or waits on a decision (pass `pendingDecision`). `SupervisorResumeTarget` is exported. Nothing changes for existing callers.
