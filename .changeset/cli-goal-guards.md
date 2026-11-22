---
'@namzu/cli': major
---

A goal no longer stops after a fixed 256 automatic turns, and it can no longer be completed by a bare report.

What changes: a goal now stops when 3 automatic turns in a row change and check nothing, or when the same check fails in 3 turns in a row; it pauses for a check-in every 50 automatic turns; it runs up to 1000 turns; and `update_goal complete` needs an `evidence` list with one entry per requirement. With the decision model on, a small model checks the report and sends back what is missing; with it off, the first report of a goal is handed back once for a self-audit.

To keep a goal going: run `/goal resume` after a check-in or a stop (a check-in resumes with no count reset); raise `goal.maxRounds` for the backstop (a resume takes the larger value); set `goal.checkInEvery` to `0` for no check-ins; set `goal.stallRounds` higher for more patience. New settings `goal.tokenBudget` (none by default; one last turn is given at the budget) and `goal.judgeModel`, and `/goal set --token-budget <n> --max-rounds <n>`. The decision point `goal` (on once a decision model is connected, `goal: off` to switch it off) controls the check of the report. `/goal status` and the line that starts each round show automatic turns, tokens and cost; the words "Up to 256 automatic replies" are gone from the goal editor.
