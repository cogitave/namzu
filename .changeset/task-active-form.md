---
"@namzu/sdk": minor
"@namzu/cli": patch
---

`task_created` and `task_updated` session events, and the ACP `AcpTask` row, gain an
optional `activeForm` (what the task reads as while it is being worked on, such as
"Running the tests"). It is absent when the model gave none, so nothing existing
changes; a host that ignores it behaves as before. A host that draws a live plan can
show it beside the task in progress. The desktop host passes it on when it lists a
session's tasks.
