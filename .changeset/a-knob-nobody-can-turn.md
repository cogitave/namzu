---
'@namzu/sdk': major
---

A delegated run is built with the config its caller asked for, and a supervisor can select its sibling-failure policy.

Two capabilities were declared, documented, typed, and unreachable. Both are the
same defect: a knob wired to nothing, which reads to a caller as a knob that
works.

**`CreateTaskOptions.configOverrides` was accepted and dropped.**
`LocalTaskGateway.createTask` built its own `configOverrides` object out of
`parentSpan` alone and never read the field, so a caller pinning a delegated run
to a cheaper model, or capping its iterations, got the agent's defaults and no
indication anything had been ignored. It is forwarded now. A caller who sets
both the field and the dedicated `parentSpan` option gets the dedicated one for
the span — that is the specific field for the job — and keeps every other
override alongside it.

**`siblingFailurePolicy` could not be selected by any host.**
`LocalTaskGateway` has honoured it since it was written and the cancellation
machinery behind `'cancel-siblings'` is complete — but it was the fifth
constructor argument of a gateway `SupervisorAgent` builds itself, and the
supervisor passed four. Every host in existence ran `'continue'`, and the only
route to the other value was to construct the gateway by hand and pass it as
`config.gateway`. It is now `SupervisorAgentConfig.siblingFailurePolicy`.

`'continue'` remains the default and deliberately so: partial results are
usually worth having, and tearing down healthy siblings on any failure lets one
flaky child waste four good ones. `'cancel-siblings'` is for a fan-out whose
parts only mean something together. The choice is now expressible; the answer
has not changed. The field is ignored when the host supplies its own `gateway`,
which owns its policy.

**Breaking:** `CreateTaskOptions.configOverrides` is now typed
`Partial<BaseAgentConfig>` instead of `Record<string, unknown>`. It lands on
`SendMessageOptions.configOverrides`, which is already that shape, and the loose
type let a misspelled key type-check and then silently do nothing — the same
silence the field was already producing. If you pass a key that is not on
`BaseAgentConfig`, it will now fail to compile; that key was never being applied.

**Also:** the two-authority failure check in `LocalTaskGateway` moves to
`taskFailed` in `tools/coordinator/outcome.ts`, next to `taskSucceeded`. It is
deliberately *not* the negation of that predicate — a task that is still running
satisfies neither, and cancelling a fan-out on `!taskSucceeded` would tear down
siblings the moment the first child had merely not finished yet. The gateway's
copy was correct; a rule each caller has to remember is one a caller eventually
forgets, which is what happened to `taskSucceeded` before it was consolidated.
