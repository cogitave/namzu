---
"@namzu/cli": patch
---

The running-workflow rows under the status row now line up as one table. Every bar starts in the same column and keeps the same width as the terminal narrows, and the count, the elapsed time and the token number each start in one column, so the clocks of a row at 1h58m and one at 16m08s sit under each other. The elapsed time on those rows reads `45s`, `16m08s`, `1h58m` instead of `16m 8s`, `1h 58m 0s`. The line that waits for background work at the end of a turn draws its mark in the same column as the closing line.
