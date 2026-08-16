---
title: Plans and Step Reporting
description: Build a plan, gate it through a human approval, report how each step went, and settle it — the half the kernel drives and the half you do.
last_updated: 2026-08-06
status: current
related_packages: ["@namzu/sdk"]
---

# Plans and Step Reporting

A plan is what a run declares it is about to do, held still long enough for a human to approve it. `PlanManager` owns that object: its steps, its status, and the events that report both.

> **Changed in `@namzu/sdk` 9.0.0, 11.0.0, and 12.0.0.** `completePlan()` now refuses an unreported step instead of scoring it a failure; steps report their own outcome through `plan_step_id` on `create_task` and through the new `update_plan_step` tool; and `plan_completed` / `plan_failed` reach the run stream. If you drove a plan before 9.0.0, read section 5 first — that is the change that breaks callers.

## 1. The Kernel Drives Half of This

The split is deliberate, and knowing which half is yours is the whole of using this surface correctly.

| Phase | Driven by | How |
| --- | --- | --- |
| build | kernel | `approve_plan` calls `startGenerating`, `addStep`, `markReady` |
| gate | kernel | the iteration context calls `approve` and `startExecution` |
| report events | kernel | the event translator wires `PlanManager` onto the run stream |
| **report step outcomes** | **host, or a delegating tool** | `updateStepStatus`, or `plan_step_id` on `create_task` |
| settle on failure | kernel | the run's error path calls `failPlan` |
| settle on success | kernel, **once every step has reported** | the run calls `completePlan` when nothing is outstanding |

`drainQuery` hands you the manager through `onContextCreated({ planManager })` before the iteration loop starts, precisely so you can drive the half the kernel does not.

This is why searching the SDK for callers of `updateStepStatus` finds none. The callers are hosts, and they are outside the package. `PlanManager` is exported for exactly this reason.

## 2. Plan and Step Status

Two separate vocabularies. `PlanStatus` describes the plan; each `PlanStep` carries its own narrower status.

| `PlanStatus` | Meaning |
| --- | --- |
| `generating` | steps are being added |
| `ready` | complete and awaiting a decision |
| `pending_approval` | a decision has been requested |
| `approved` / `rejected` | the human answered |
| `executing` | approved and under way |
| `completed` / `failed` | terminal |

`isTerminalPlanStatus()` returns `true` for `completed`, `failed`, and `rejected`.

| `PlanStep['status']` | Meaning |
| --- | --- |
| `pending` | the default from `addStep`; nobody has reported |
| `running` | started |
| `completed` | done |
| `skipped` | planned, then not needed — a **successful** outcome |
| `failed` | attempted and did not work; `error` carries why |

`skipped` being first-class matters. A plan that turned out not to need a step went right, and forcing that into `completed` or `failed` would make the plan lie in one direction or the other.

## 3. What the Approver Sees

`approve_plan` asks the model for an `agent_id` per step, and that answer reaches the human on both approval surfaces.

The approval is the one moment where the difference can still be acted on. Approving "delegate this step" is not the same as approving "delegate this step to the agent with shell access", and a reviewer who cannot see which agent was chosen cannot withhold approval from the wrong one.

### There are two approval surfaces, and both carry it

They are different types, declared separately, and each mapper copies field by field — so knowing which one you receive matters.

| Surface | You get it by | Step shape |
| --- | --- | --- |
| `PlanApprovalRequest` | installing your own handler on `PlanManager` | `PlanStep`, `agentId` since 9.0.0 |
| `PlanApprovalData` | a `resumeHandler` — **the ordinary path** | its own inline step shape, `agentId` since 12.2.0 |

> **`PlanApprovalData.steps[].agentId` is new in `@namzu/sdk` 12.2.0.** From
> 9.0.0 through 12.1.0 the field reached `PlanApprovalRequest` and stopped
> there, so the busier of the two surfaces kept showing
> `toolName: 'create_task'` and nothing else — which is the exact gap the field
> was added to close. If you approve plans through a `resumeHandler`, you need
> 12.2.0 for the agent name to arrive.

An **absent** `agentId` is not missing data — it says the step is the orchestrator's own work, which is what omitting `agent_id` means. That distinction drives section 4.

### A plan cannot name an agent the run could not launch

> **New in `@namzu/sdk` 12.2.0.**

`approve_plan` refuses a step whose `agent_id` is not on the run's delegate roster. The model gets a recoverable error naming the agents it may actually use — or, on a run with no delegates at all, telling it to plan the work as its own steps — and **the human is never shown the step**, because the check runs before the plan is built.

`create_task` has always constrained the same field with a closed enum while `approve_plan` typed it as a bare string. The mismatch was invisible while the name was being dropped on the way to the approver; once a step carries the name, an approver could read "delegate to X" for an X that does not exist and approve a delegation the launch would then reject.

The check lives in `execute` rather than in the schema, deliberately. `approve_plan` is mounted even with an empty roster — planning with no delegates but a human channel is a supported configuration — and an empty enum renders as a schema shape that strict tool-schema validators reject wholesale, taking the entire request down rather than the one tool. `create_task` escapes that by being withheld entirely when the roster is empty; `approve_plan` cannot be.

### Step ids come back to the caller

`approve_plan` returns the step ids, both in its text output and in `data.steps`. Both reporting routes below name a step id, and a binding whose caller has never been told the ids is a binding that does not exist.

## 4. Two Ways a Step Reports, Because There Are Two Kinds of Step

**A delegated step reports through the launch that carries it out.** Pass `plan_step_id` to `create_task`, and the step goes `running` when the worker starts and `completed` or `failed` when it settles:

```
create_task(agent_id: "reviewer", plan_step_id: "step-2", prompt: "…")
```

The outcome comes from the same two-authority check the tool result uses, so a worker that returned `status: 'failed'` fails its step even when the gateway recorded the task as completed.

**An orchestrator-owned step has no tool call to bind to at all.** A step with no `agent_id` is work the model does itself, and `update_plan_step` is how it reports:

```
update_plan_step(step_id: "step-3", status: "skipped")
```

Without this tool, a plan containing one such step could never settle however well it went.

From a host, the same reporting is one call:

```ts
import type { PlanManager } from '@namzu/sdk'

declare const planManager: PlanManager

planManager.updateStepStatus('step-3', 'skipped')
```

Report each step as it settles rather than batching at the end. An unreported step is not scored as a failure — it simply leaves the plan unsettled.

## 5. Settling, and the Call That Now Throws

`completePlan()` **throws when any step is still `pending` or `running`.**

Before 9.0.0 it asked one question — is every step `completed` or `skipped`? — and everything else fell to the same branch, producing `status: 'failed'`. Since `addStep` defaults every step to `pending`, a host that added steps, did the work, and settled without reporting got `failed` for a plan where nothing had gone wrong. That is the path of least effort through this API, not an unusual one.

The two cases are different facts. A step that failed is an outcome: report the plan failed. A step nobody reported on is not an outcome at all — it says the caller and the plan disagree about whether the work is over, and answering `failed` settles that disagreement by inventing a result.

Two ways forward, and only you know which applies:

| Situation | Do this |
| --- | --- |
| you forgot to report progress | call `updateStepStatus` on each outstanding step — `'skipped'` is valid |
| you are abandoning the plan | call `failPlan(reason)`, which marks unfinished steps `skipped` and settles the plan as `failed` |
| you called too early | check `planManager.unreportedSteps` first and wait |

`unreportedSteps` is the read that lets you avoid the throw entirely. The run itself uses it: on a successful run the kernel settles the plan only when nothing is outstanding, and leaves it `executing` otherwise. Letting `completePlan` throw at the end of a run that worked would turn it into a run that crashed on its way out, and a plan with silent steps is honestly unsettled rather than dishonestly closed.

Behaviour is unchanged once every step has reported: all `completed` or `skipped` still yields `completed`, and any `failed` still yields `failed`.

`failPlan(reason)` records its argument on `Plan.failureReason`. This is distinct from `rejectionReason`, which is a human declining a plan *before* it ran; `failureReason` is a plan that ran and did not finish.

## 6. Watching a Plan From Outside

Every transition reaches the run stream. `RunEvent` carries the plan events, and the SSE bridge maps them to wire names:

| `RunEvent` | SSE `StreamEventType` |
| --- | --- |
| `plan_ready` | `plan.ready` |
| `plan_approved` | `plan.approved` |
| `plan_rejected` | `plan.rejected` |
| `plan_step_updated` | `plan.step_updated` |
| `plan_completed` | `plan.completed` |
| `plan_failed` | `plan.failed` |

Before 12.0.0 the last two emitted nothing, so a host watching the stream saw the steps report and then silence — it could learn a plan had been approved and never that it closed, leaving a plan rendered as in-flight indefinitely.

`plan_failed` carries a `reason`, populated from `Plan.failureReason` — an event that says "failed" without saying why puts the reader back where the missing event did. `plan_rejected` carries a `reason` too, and they are different facts: rejection is a human declining, failure is a plan that ran and did not finish.

The A2A bridge is narrower on purpose: only `plan_ready` crosses, mapping to task state `input-required`. The rest are this runtime's business rather than a peer's.

**If you switch exhaustively over `RunEvent` or `StreamEventType`, both are wider as of 12.0.0** and need arms for the new members.

## 7. Building Your Plan in `onContextCreated`

`onContextCreated` is the callback for this work, and as of 12.0.0 it fires where it can be heard: after the event translator is wired and after run-store initialisation, still before the iteration loop. Previously it ran ahead of the wiring, so a host that built its plan there did it into silence — `plan_ready`, `plan_approved`, and every `plan_step_updated` emitted with nothing subscribed.

`PlanManager.on(listener)` is the subscription, and it returns the function that unsubscribes.

```ts
import { drainQuery, type QueryParams } from '@namzu/sdk'

declare const params: Omit<QueryParams, 'onContextCreated'>

await drainQuery({
  ...params,
  onContextCreated({ planManager }) {
    planManager.on((event) => {
      console.log(event.type, event.plan.status)
    })
  },
})
```

A `PlanEvent['type']` is dotted — `plan.ready`, `plan.step_updated`, `plan.completed` — where the `RunEvent` names in section 6 are underscored. They are two vocabularies for the same transitions: `PlanEvent` is what this manager emits to its own listeners, and the event translator is what turns each one into the `RunEvent` the run stream carries.

## Related

- [Low-Level Runtime](./low-level.md) — `drainQuery`, resume handlers, and the HITL park
- [Agents and Orchestration](../agents/README.md) — `create_task` and the coordinator tool set
- [Event Bridges](../integrations/event-bridges.md) — SSE and A2A wire mapping
- [Tool Safety](../tools/safety.md) — plan mode and the tool-review gate
- [Runtime](./README.md)
- [Plan Manager Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/manager/plan/lifecycle.ts)
