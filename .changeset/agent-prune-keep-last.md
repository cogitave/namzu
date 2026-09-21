---
"@namzu/sdk": minor
---

`BaseAgentConfig.pruneKeepLast` sets checkpoint retention for a run started
through `ReactiveAgent` or `SupervisorAgent`, the same way
`runConfig.pruneKeepLast` does for a raw `query()` run. Both agents build their
run config from a hand-listed literal, so a host that bounded its own runs
could not bound a delegated child's, and the child kept every checkpoint.
Absent keeps every checkpoint, as before. No existing behaviour changes.
