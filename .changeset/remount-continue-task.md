---
'@namzu/sdk': minor
---

`continue_task` is registered again. A supervisor can redirect a background
worker instead of only waiting for it or killing it — and killing it throws
away everything it has done.

The tool was dropped because the queue it wrote to had no reader: on a live
task the manager accepted the call and pushed onto `pendingMessages`, and
nothing drained that queue during a run, so registering it would have
handed the model a call that silently does nothing. The comment recording
that named its own expiry condition — "if follow-ups on a live worker are
wanted, the work is a consumer for the queue" — and that consumer now
exists.

It rides under the same `canDelegate` gate as `create_task`,
`wait_for_task` and `cancel_task`: steering a live worker is delegation
too, so a run that must not delegate cannot redirect one either.

It refuses a task this run did not launch, applying the same fencing the
listing and the wait already do, so one run cannot steer another's worker on
a shared scheduler. "Never existed" and "belongs to someone else" get the
same answer, because distinguishing them confirms a task id the run was not
supposed to know.

A settled task is reported as a refusal naming the state, not as a thrown
tool error — the manager refuses by throwing, and a throw out of `execute`
reads to the model as "the platform broke" rather than "that worker has
finished". It does not block: the worker's result still arrives the way it
already would.
