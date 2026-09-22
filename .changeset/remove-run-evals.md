---
"@namzu/evals": major
---

Requires `@namzu/sdk >=44.0.0` (was `>=5.0.0`): the suites build their cases on
the SDK's turn API (`evalTurnFromTurn`), which does not exist before 44. An
earlier `@namzu/evals` breaks against SDK 44, and this one does not load
against an older SDK. No case, score or report shape changed.

What to do: upgrade `@namzu/sdk`, `@namzu/cli` and `@namzu/evals` together.
