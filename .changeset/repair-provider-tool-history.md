---
'@namzu/sdk': minor
'@namzu/cli': patch
---

Repair provider-invalid tool history chronologically before the first model
call. Abandoned calls receive an explicit unknown-outcome error result while
checkpoint calls still owned by approval or crash recovery retain their exact
assistant state and execute only through that authority path. The SDK adds the
public `repairToolMessageHistory` projection and `message_history_repaired`
`RunEvent`; CLI transcripts surface the measured repair without exposing tool
content.
