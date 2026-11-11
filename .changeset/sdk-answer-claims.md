---
"@namzu/sdk": minor
---

New: `compareAnswerToOutcome(answer, outcome)` checks an answer's plain claims about checks ("all tests pass", "the build succeeds", "lint is clean", "type checking passes") against the same turn's outcome record and returns one `AnswerClaimMismatch`, or nothing. It reports only when the record says a check failed, or says files changed and no check ran or none could be read; it is silent on negations, hedges, conditions, questions, quotations, code, reported speech and past statements, and reads English only. The live `turn_completed` settlement carries it as the optional `claimMismatch`; the model is not told and nothing blocks. Also new: `describeAnswerClaimMismatch`, `outcomeScorer` and `claimMismatchScorer` for the eval harness, and `EvalTurn` now has optional `outcome` and `claimMismatch`, filled by `evalTurnFromTurn`. Nothing to change on your side: every addition is optional.
