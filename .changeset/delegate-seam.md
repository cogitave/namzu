---
'@namzu/sdk': minor
---

A delegate need not be an in-process Namzu agent.

Delegation was reachable exactly one way: `TaskScheduler.createTask` with an `agentId` the host's `AgentManager` could resolve. Every delegate was therefore a Namzu agent, in this process, built from this kernel's own definition — so a host with a specialist behind an A2A card, an ACP connection, or any service at all had nowhere to put it short of implementing the whole `TaskScheduler` surface, most of which is bookkeeping the kernel already does.

New: the `Delegate` seam — take a prompt, return an outcome, declare whether you can be cancelled or continued — and `DelegatingTaskScheduler`, which presents any set of them as the `TaskScheduler` the delegation tools already speak. An id no delegate claims falls through to the local scheduler untouched.

**The mapping onto `TaskHandle` is the load-bearing part.** `taskSucceeded` and `taskFailed` require the gateway state and the run status to agree, because locally they are two independent authorities. A foreign delegate has one word, so it is written onto both — and a cancellation is written as `canceled`/`cancelled`, never as a failure: `SiblingFailurePolicy: 'cancel-siblings'` acts on `taskFailed`, so calling a deliberate stop a failure would tear down every healthy sibling as a consequence of the stop.

Capabilities are refused, not degraded. `continueTask` against a delegate that cannot continue throws rather than silently doing nothing — a no-op there has the parent believe it steered a worker that never heard it. A capability claiming a method the object does not implement is refused at registration, and two delegates claiming one id are refused rather than resolved by registration order.

The roster is still enforced upstream: the delegation tools check `allowedAgentIds` before an id reaches any scheduler, so registering a delegate does not by itself make it reachable.
