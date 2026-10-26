---
'@namzu/sdk': minor
'@namzu/cli': patch
---

`ask_user_question` no longer tells the model that plan ratification goes through `approve_plan` in a host that does not mount that tool. `buildAskUserQuestionTool` takes an optional `planApprovalTool` naming the host's approval tool; without it the description says "the plan-approval tool". The coordinator passes `approve_plan` when it mounts that tool, and the terminal passes `exit_plan_mode` when plan mode can be approved. A host that builds the tool itself and mounts an approval tool should pass its name.
