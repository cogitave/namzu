---
"@namzu/sdk": minor
---

Add `CompletionInbox.deferDelivery(taskId, settlement)` and `drainAsync(signal?)` so hosts can await an owned task's tracking writes before delivering its result. The existing synchronous `drain()` keeps pending deferred results queued and reports rejected writes without consuming results. Cancelling an asynchronous drain releases its waiter while retaining the tracking promise and result. Query notification waits respect the caller's existing cancellation/deadline, and finalizers and outstanding-work holds never wait again on pending tracking.

Coordinator background workers and abandoned foreground waits now settle their linked planning task and original approved plan step from the actual worker outcome exactly once. Completion notifications and explicit waits await that settlement. Replacing the active plan cannot redirect an old worker's outcome to a reused step ID. Direct background launches without a completion channel are refused before starting a worker.

Rejected scheduler admission also fails the linked planning record and original plan step rather than leaving them running. The original admission error is retained, an uncertain worker dispatch is not represented as absent, and failed tracking persistence reports both errors without retrying the worker.
