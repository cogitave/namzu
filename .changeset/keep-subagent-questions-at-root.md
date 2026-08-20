---
'@namzu/sdk': major
---

Stop delegated `SupervisorAgent` runs from publishing `ask_user_question`, including a host tool registered under the same name. Existing hosts that let child supervisors prompt an operator must route that decision through the root supervisor instead. Delegated runs still inherit `resumeHandler` for REVIEW-tier tool authorization; the change does not auto-approve child tool calls.

Make `AgentManager` authoritative for child `depth` and `parentRunId` after config builders and per-spawn overrides. Builders that deliberately replaced those lineage fields can no longer do so; derive child behavior from the manager-stamped lineage instead.
