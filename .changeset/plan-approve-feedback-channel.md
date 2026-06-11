---
'@namzu/sdk': minor
---

Add an optional feedback channel to plan approvals: `HITLResumeDecision`'s
`approve_plan` variant now carries `feedback?: string`, the plan-approval
resume handler forwards it as `PlanApprovalResponse.feedback`, and the
coordinator `approve_plan` tool embeds approve-with-edits feedback in the
model-visible tool result so the supervisor applies the user's edits
atomically with the approval. Bare approvals are byte-identical to before;
existing resume handlers compile and behave unchanged.
