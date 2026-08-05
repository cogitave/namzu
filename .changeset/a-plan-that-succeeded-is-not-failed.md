---
'@namzu/sdk': major
---

`PlanManager.completePlan` refuses an unreported step instead of scoring it a failure.

**A plan that fully succeeded was reported as failed.** `completePlan` asked one
question — "is every step `completed` or `skipped`?" — and everything that was
not fell to the same branch. A step still `pending` therefore produced
`status: 'failed'`, indistinguishable from a step that genuinely failed. Since
`addStep` defaults every step to `pending`, a host that added steps, did the
work, and settled the plan without calling `updateStepStatus` on each one got
`failed` for a plan where nothing had gone wrong. That is the path of least
effort through this API, not an unusual one.

The two cases are different facts and deserve different answers. A step that
FAILED is an outcome: report the plan failed. A step nobody reported on is not
an outcome at all — it says the caller and the plan disagree about whether the
work is over, and answering `failed` settles that disagreement by inventing a
result.

**What changes for you.** `completePlan()` now throws when any step is still
`pending` or `running`. The message names the unfinished steps and both ways
forward, because a caller in this position either forgot to report progress or
called too early, and only they know which:

- report each step with `updateStepStatus` — `'skipped'` is a valid outcome for
  work that was planned and then not needed; or
- call `failPlan` if the plan is being abandoned, which marks unfinished steps
  `skipped` and settles the plan as failed.

Behaviour is unchanged once every step has reported: all `completed` or
`skipped` still yields `completed`, and any `failed` still yields `failed`.
No code in this repository called `completePlan`, so nothing inside the kernel
changes behaviour; the affected callers are hosts.

**`PlanManager` now says which half of it the kernel drives.** The kernel builds
a plan, gates it, translates its events, and settles it on failure — it never
reports a step outcome and never settles a plan that succeeded. That is a
deliberate split, since `drainQuery` hands the manager to the host through
`onContextCreated` for exactly this purpose, and a search for callers inside the
package finds none because the callers are outside it. The absence had already
been read once as a dead layer and proposed for deletion; what that would have
deleted is a working human-in-the-loop approval gate. It is written down now.
