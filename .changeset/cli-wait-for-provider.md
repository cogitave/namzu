---
"@namzu/cli": minor
---

A headless run can wait out a provider pause and resume itself. `namzu run --wait-for-provider <duration>` (`90s`, `30m`, `2h`) and the `limits.waitForProviderMs` config key give the run a budget of time to spend waiting when the provider pauses it — a rate limit, an outage. It waits the provider's own delay when one was named, otherwise a minute doubling to fifteen, then resumes from the checkpoint the pause kept, in the same process and with the run's own context; a wait that would overrun the budget is not taken and the run exits 75 saying why. Without a budget nothing changes: exit 75 at once. `AgentSession` gains `resumePaused({ runId, checkpointId })`, a streaming resume of the session's own paused run, and the `paused` event now carries `runId`; a host that builds `AgentSession` objects by hand has to add the method.
