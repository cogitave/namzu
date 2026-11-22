---
'@namzu/cli': major
---

`goal.checkInEvery` now defaults to 0 (off): an automatic goal no longer pauses after every 50 turns. It still stops when it makes no progress, repeats the same failure, reaches `goal.tokenBudget` or `goal.maxRounds`. To keep the old pause, set `goal.checkInEvery` to 50.
