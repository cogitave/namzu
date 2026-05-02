---
'@namzu/sdk': minor
---

feat(sdk): ReactiveAgent forwards verificationGate to drainQuery

Adds an optional `verificationGate?: VerificationGateConfig` field on
`ReactiveAgentConfig` and forwards it through `ReactiveAgent.run()` into
`drainQuery`, mirroring the existing `SupervisorAgentConfig.verificationGate`
plumbing. Without this, child agents running under `ReactiveAgent` could not
opt into the same capability-aware deny/allow rules the supervisor already
uses — the only path was `drainQuery`'s `autoApproveHandler` default, which
approves every tool call silently. Hosts that want defense-in-depth at the
child level (deny dangerous shell patterns, restrict by category) can now
pass the same preset they pass to the supervisor.
