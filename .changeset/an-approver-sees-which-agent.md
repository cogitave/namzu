---
'@namzu/sdk': minor
---

An approver sees which agent, on both approval surfaces, and is never shown a step that cannot run.

**There are two approval surfaces, and the previous release fixed one of them.**
`PlanStep.agentId` was added so an approver could see WHICH agent a step goes to
rather than only THAT it delegates. It reached `PlanApprovalRequest` — the shape
a host sees when it installs its own handler on `PlanManager` — and stopped
there. `PlanApprovalData`, which is what every `resumeHandler` host receives,
declares its own step shape, and both mappers that build it copy field by field.
So the busier surface kept showing `toolName: 'create_task'` and nothing else:
exactly the behaviour that change set out to end.

`PlanApprovalData.steps[]` now carries `agentId`, populated in both mappers.

**A plan may no longer name an agent the run cannot launch.** `create_task`
constrains `agent_id` with a closed enum while `approve_plan` typed the same
field as a bare string, so a model could propose — and, now that the name is
visible, a human could approve — "delegate to X" for an X that `create_task`
rejects at schema-parse time. `approve_plan` now refuses such a plan.

The check is in `execute`, not in the schema, and both halves of that are
deliberate:

- **Not the schema.** `approve_plan` is mounted even with an empty roster,
  because planning with no delegates and a human channel is a supported
  configuration, and `z.enum([])` renders as `{"not":{}}` — the shape
  `delegateSchema` already refuses, because a strict tool-schema validator
  rejects the whole request over it rather than the one tool. `create_task`
  escapes that by being withheld entirely; this tool cannot be.
- **In `execute`, before `startGenerating`.** So the refusal leaves no
  half-built plan behind, and the human is never shown the bad step at all. The
  message names the roster, so the model corrects itself in one turn.

Enforcing in `execute` as well as the schema is the precedent the canonical
`Agent` tool set for complete mediation.
