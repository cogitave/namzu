---
'@namzu/sdk': minor
---

The plan a human approves names the agent the model chose.

`approve_plan` asks the model for an `agent_id` per step — "which agent handles
this" — and reduced the answer to a boolean. The step got
`toolName: 'create_task'` when any agent was named and nothing when not, so the
name was dropped between the model saying it and the human being shown the plan.

The approval is the one moment where that difference can still be acted on.
Approving "delegate this step" is not the same as approving "delegate this step
to the agent with shell access", and a reviewer who cannot see which agent was
chosen cannot withhold approval from the wrong one. Two delegated steps reached
the approver identical in every field.

`PlanStep` gains `agentId?: string`, populated by `approve_plan` from the
model's choice. A host rendering a plan approval can show it directly. Absent
still means the step is the orchestrator's own work, which is what omitting
`agent_id` says — so absent stays absent rather than becoming a placeholder.

Typed rather than folded into the existing `estimatedInput`, which is `unknown`:
an approval gate's whole job is being readable, and a field a host must cast
before it can render is one a host renders wrong or not at all. `estimatedInput`
is now documented as having no producer and no reader, since that is what it
has, and it is left in place because it is on the published typings.
