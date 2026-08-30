---
uid: namzu.sdk.command-execution-lifetime
title: Command execution lifetime and cancellation
description: Reference for local command admission, cancellation outcomes, nullable exits, remote cancellation refusal, and disconnect or teardown ownership in the SDK execution contexts.
type: Reference
diataxis: reference
owner: cogitave/namzu
status: active
timestamp: 2026-08-30T00:00:00Z
lastReviewed: 2026-08-30
resource: packages/sdk/src/types/execution/index.ts
tags: [sdk, execution, cancellation, lifecycle]
---

# Command execution lifetime and cancellation

`CommandExecutor.executeCommand()` reports both the process outcome and any
Namzu-owned termination request. A numeric exit and a termination request are
different facts: a process can exit because of an external signal without
Namzu requesting it, and a pre-aborted caller can prevent admission without a
process ever existing.

## Result contract

`CommandResult.exitCode` is `number | null`. `null` means the operation has no
numeric process exit; it does not by itself mean Namzu cancelled the command.
Inspect `termination` for that claim.

| Result shape | Meaning |
|---|---|
| numeric `exitCode`, no `termination` | The child reported a normal numeric exit. |
| `exitCode: null`, no `termination` | The child closed without a numeric exit, for example after an external or self-signal. |
| `termination: { origin: 'caller', admitted: false }` | The supplied signal was already aborted and local execution did not spawn. |
| `termination` with `admitted: true` | Caller cancellation, timeout, or context teardown was the first Namzu-owned termination request. |

For admitted work, `termination.signal` is the direct child's actual close
signal when the runtime reports one. It is not the signal Namzu first requested:
a command can receive `SIGTERM`, resist it, and close only after escalation to
`SIGKILL`.

```ts
import type { CommandResult } from '@namzu/sdk'

export function describeCommand(result: CommandResult): string {
	if (result.termination?.admitted === false) return 'cancelled before admission'
	if (result.termination) {
		return `${result.termination.origin}: ${result.termination.signal ?? 'no close signal'}`
	}
	return result.exitCode === null ? 'closed without a numeric exit' : `exit ${result.exitCode}`
}
```

## Local execution

`LocalExecutionContext` accepts `CommandOptions.signal`. If the signal is
already aborted, it returns the not-admitted result without spawning. After
admission, the first of caller cancellation, deadline, and context teardown
wins the `termination.origin` race. Later causes do not rewrite it.

Cancellation settles only after the owned process group reaches the command's
close boundary and inherited output streams drain. The context first requests
graceful termination and escalates if the process group does not close. A
caller must therefore treat the returned promise, not the abort event, as the
proof that admitted local work has stopped.

Calling `teardown()` closes admission synchronously. It cancels every command
already admitted, waits for their close promises, and only then publishes a
successful teardown. Call `initialize()` and wait for it to commit before
reusing a torn-down context.

## Generic remote execution

`RemoteExecutionContext` rejects every supplied `CommandOptions.signal` before
invoking either its structured executor or legacy handler. That seam has no
reservation identifier, separate cancellation operation, or terminal
acknowledgement, so forwarding a signal would claim a remote stop it cannot
prove. Use `Sandbox.exec()` when the selected backend implements cancellable
remote execution under that stronger contract.

The remote context tracks every command it does admit. `disconnect()` and
`teardown()` reject with `RemoteExecutionBusyError` while the active count is
non-zero; they do not publish a false disconnect or teardown event. Wait for
the command promise to fulfill or reject, then retry. Bulk hybrid disconnect
propagates one failure directly and uses `AggregateError` when several remotes
fail.
