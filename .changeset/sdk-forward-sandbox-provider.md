---
'@namzu/sdk': minor
---

feat(sdk): forward sandboxProvider through reactive/supervisor agents

`ReactiveAgentConfig` and `SupervisorAgentConfig` gain an optional
`sandboxProvider?: SandboxProvider` field. When set, the agent's
`runConfig` builder forwards the provider into `drainQuery`'s
`sandboxProvider` slot, so the supervisor — and every child
specialist run that inherits the supervisor's run config — gets
the same per-task ephemeral container.

Without this plumbing, a host that wires `sandboxProvider` only on
the supervisor sees the field silently dropped before child
specialists are spawned, and each child runs without a sandbox.
The forwarding closes that gap so multi-agent hosts can pass a
single per-task provider instance and have supervisor + every
child share one container.

Pure additive change — `SupervisorAgent` / `ReactiveAgent`
constructors that don't pass `sandboxProvider` behave exactly as
before.
