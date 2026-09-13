---
"@namzu/sdk": minor
---

Add optional `AnswerReviewContext.latestUserMessage`, an isolated copy of the
latest accepted operator, goal-round or steering input before the candidate's
model dispatch. It uses the run's existing retained input tracking across
compaction and checkpoint resume. Later arrivals do not relabel an older
candidate, and runtime reports do not replace operator intent. This single
input is not a complete task specification or a verbatim provider-wire record.

Fix tool-mode structured settlement dropping inbound messages or steering that
arrived during the candidate's request or tool execution. While run limits
permit, the loop handles the new input before publishing a new candidate,
including when no output reviewer is installed.
