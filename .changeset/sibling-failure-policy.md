---
'@namzu/sdk': minor
---

A fan-out can now declare what a failed child means for its siblings.

The primitive to stop them already existed — every child holds an abort
controller chained to the parent's, and `AgentManager.cancel` uses it — but
nothing connected a failure to it. A supervisor that fanned out five tasks
and watched one die had no way to say the other four were now pointless:
they ran to completion, spending budget on work whose premise had gone.

`LocalTaskGateway` takes a `SiblingFailurePolicy`:

- `'continue'` — the default, and deliberately unchanged. Partial results
  are usually worth having, and cancelling healthy siblings on any failure
  would let one flaky child waste four good ones.
- `'cancel-siblings'` — for a fan-out whose parts only mean something
  together, where one dead leg makes the rest an answer nobody can use.

Failure is judged from the result as well as the task state. A child whose
spawn machinery threw lands in state `'failed'`, but a child that RAN and
returned `status: 'failed'` is marked completed and carries the failure in
its result — so reading only the state would have caught the exceptional
case and missed the ordinary one.
