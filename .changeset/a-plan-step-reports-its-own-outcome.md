---
'@namzu/sdk': major
---

A plan step reports its own outcome, so a plan that succeeded can say so.

A plan's steps had no relationship to the work that carried them out.
`approve_plan` built steps, `create_task` launched workers, and nothing
connected the two — so no step could ever be observed, `updateStepStatus` had no
production caller anywhere, and a plan could reach `failed` (the error path
calls `failPlan`) or sit at `executing` forever, but never `completed`. A host
reading `plan.status` after a fully successful run was told the work was still
going.

**Two bindings, because there are two kinds of step.**

- A **delegated** step reports through the launch that carries it out:
  `create_task` gains `plan_step_id`. The step goes `running` when the worker
  starts and `completed` or `failed` when it settles — from the same
  two-authority check the tool result uses, so a worker that returned
  `status: 'failed'` under a gateway state of `completed` fails its step.
- An **orchestrator-owned** step — one with no `agent_id` — has no tool call to
  bind to at all. The new `update_plan_step` tool is how it reports, and without
  it a plan containing one could never settle however well it went. `skipped` is
  a first-class outcome there: a plan that turned out not to need a step went
  right, and forcing that into `completed` or `failed` would make the plan lie
  in one direction or the other.

**`approve_plan` now tells the model the step ids**, in its output and in
`data.steps`. Both bindings name ids, and a binding whose caller has never been
told the ids is a binding that does not exist.

**The run settles the plan on success**, but only when every step has reported.
The check is a read — the new `PlanManager.unreportedSteps` — rather than a
caught throw: `completePlan` refuses an unreported step on purpose, and letting
that throw at the end of a successful run would turn a run that worked into a
run that crashed on its way out. A plan with silent steps is left `executing`,
which is the honest answer.

**Breaking:** `update_plan_step` is a new name in the coordinator tool set, so a
host that registers its own tool under that name will now get
`ToolNameCollisionError` at run start. `approve_plan`'s approved output is no
longer byte-identical — it opens with the same sentence and continues with the
step roster; the historical text is still the prefix, and `data.steps` is there
so a host need not parse prose.
