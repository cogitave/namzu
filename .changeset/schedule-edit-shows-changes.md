---
'@namzu/cli': patch
---

Confirming an edited scheduled job now lists what changed since it was last confirmed, as `+` and `-` lines above the question, in `namzu schedule edit`, `namzu schedule confirm` and `/schedule confirm`. An edit saved with `--yes` records the lines in the job's history (`changes` on the `edited` record in `schedule history --json`) so the later confirmation can show them.
