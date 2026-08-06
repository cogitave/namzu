---
'@namzu/sdk': patch
---

A concurrent fan-out no longer kills most of its own launches.

`LocalTaskGateway.createTask` passes a progress tee into `sendMessage`, and that
callback read `task.taskId` — the `const` that the very same `await` assigns. So
a child that emitted any run event before `sendMessage` resolved reached that
line inside the temporal dead zone and threw `Cannot access 'task' before
initialization`, taking the whole launch down with it.

Two things kept it hidden. A single sequential launch usually resolves before
the child says anything, so the ordering rarely bit. And the throw only happens
when a progress listener is actually attached — with an empty subscriber set the
loop body never runs and the dead zone is never entered, which is why no unit
test caught it. `create_task` attaches one for its idle bound on every blocking
launch, so production always had one.

Under a concurrent fan-out both conditions hold. Observed on the published
package: four `create_task` calls from one assistant turn — the shape that
tool's own description tells the model to use — and three of the four died with
`create_task failed: Cannot access 'task' before initialization`.

The tee now reads an id filled in after the spawn resolves, and reports nothing
before then. That window is not a loss: with no id the caller does not yet hold
the handle, so no idle bound is running against the task and there is no
progress to attribute to anyone.

Introduced in #130 with the idle-bound work. Found by running a live concurrent
fan-out against the published package rather than by any test.
