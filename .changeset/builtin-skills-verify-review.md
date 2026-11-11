---
'@namzu/cli': minor
---

Two new built-in skills. `verify-change` is offered when the model is about to say a change works: it runs the changed behaviour for real, runs the project's own check as a plain command (so the turn's record can tell whether it passed), and reports one of works, does not, or could not be exercised, with the evidence. `review-changes` looks for defects in a change and reports only those it could make concrete and check. The skill list the model receives is now two entries longer, and the built-in descriptions each end with what the skill is not for. A skill of the same name in your own folders still shadows a built-in, and `skills.builtin: false` leaves them out.
