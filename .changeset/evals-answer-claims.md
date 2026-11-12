---
"@namzu/evals": patch
---

`@namzu/evals` gains the `kernel/answer-claims` suite: eight scripted cases that pin what the kernel records when an answer says a check passed (after a failing check, after changes nobody checked, after a check whose result was hidden) and that the comparison stays silent after a passing check, after no change, on a negation and on an honest account. It needs an `@namzu/sdk` that has `outcomeScorer` and `claimMismatchScorer`; against an older SDK the suite fails to load. Nothing to change on your side.
