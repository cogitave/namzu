---
'@namzu/sdk': major
---

A completion inbox hears only about the tasks its own run launched, and a supervisor releases the gateway it borrowed

`TaskGateway.onTaskCompleted` is a broadcast and `TaskHandle` carries no run id,
so every inbox attached to a gateway was handed every completion on it.
Measured: two inboxes on one gateway, one run launches a task, and the OTHER
run drains it — it would have been told "a task you launched has finished", a
false statement, over another run's worker output. A shared gateway is not an
abuse of the API: `SupervisorAgentConfig.gateway` takes one, and a host that
owns a gateway reuses it.

Separately, nothing ever called `CompletionInbox.close()`. Three sequential
`SupervisorAgent` runs against one host gateway left three live subscriptions,
each still holding its run's handles, and the set only grew.

**Breaking, and what to do.**

- `CompletionInbox` now ignores a completion for a task it was not told about.
  If you drive `buildCoordinatorTools` there is nothing to do — `create_task`
  declares every launch, blocking and background alike. If you launch tasks
  some other way and expect notifications, call `inbox.launched(taskId)` after
  the launch. `inbox.expect(taskId)` already implies it.
- `SupervisorAgent` closes the inbox it created when the run ends, including
  when setup throws. An inbox you construct yourself is still yours to close.
- `close()` now clears what the inbox owned and claimed as well as what it
  queued, so a closed inbox cannot be re-armed through a stale reference.

The ordering that would otherwise turn this into lost results is handled in
two layers. `gateway.createTask` resolves one microtask before its caller can
say who owns the task, so a worker that finishes inside that window is
announced first. An unowned announcement is therefore BUFFERED rather than
dropped, and ownership may be claimed retroactively; the buffer is bounded at
32 entries so that on a shared gateway it cannot accumulate every other run's
worker output, and an eviction is logged at WARN so a dropped completion is
never inferable only from an absence. Where the buffer could not hold an entry,
`launched()` also asks `gateway.getTask` — an assumption that a just-settled
task is still findable, now stated on `TaskGateway.getTask` itself so a host
that cannot meet it knows it is the one paying.
