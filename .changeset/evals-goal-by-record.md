---
"@namzu/evals": minor
---

New suite `kernel/goal-by-record`: four scripted goals (reported met after a failing check then fixed, after editing past a passing check, with no check available, and a check that never passes) each run under the present behaviour and with the goal confirmed by the record, scoring the kernel's record, how the goal ended and how many model calls it took. It needs a kernel that exports `GoalConfirmation`; nothing in existing suites changes.
