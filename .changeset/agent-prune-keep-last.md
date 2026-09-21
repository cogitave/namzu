---
"@namzu/sdk": minor
---

`BaseAgentConfig.pruneKeepLast` sets checkpoint retention for a turn started
through `ReactiveAgent` or `SupervisorAgent`, the same way
`turnConfig.pruneKeepLast` does for a raw `query()` turn. Both agents build
their turn config from a hand-listed literal, so a host that bounded its own
turns could not bound a delegated child session's, and the child kept every
checkpoint. Absent keeps every checkpoint, as before.
