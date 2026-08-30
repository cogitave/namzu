---
'@namzu/sdk': major
---

Make command cancellation and shutdown outcomes explicit. `CommandResult.exitCode`
is now `number | null`, and cancelled results may carry a discriminated
`termination` describing the first Namzu-owned cause, admission state, and
actual close signal. Consumers must handle a missing numeric exit and inspect
`termination` when they need to distinguish caller cancellation, timeout, and
teardown.

`CommandOptions.signal` is now reserved for `AbortSignal`; rename an unrelated
structural `signal` field before upgrading. Local execution owns accepted work
through process-group close. Generic remote executors reject every supplied
signal before invocation because their contract cannot prove remote quiescence;
use the sandbox execution contract for cancellable remote work.

Remote disconnect and teardown now reject while commands are active, and
`HybridExecutionContext.disconnectAllRemotes()` propagates disconnect failures.
Wait for active commands to settle and retry shutdown, and handle failures from
bulk disconnect instead of assuming it always resolves.
