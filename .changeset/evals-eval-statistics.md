---
"@namzu/evals": patch
---

Every suite now states in its report that it is scripted (or uses no model), so a comparison can say what produced a score; this needs no change on your side and an older `@namzu/sdk` ignores it. `kernel/context` copies its starting messages for each run: before, running the same case twice in one process (`namzu eval --repeat`) handed the second run the ids the first had minted, and the case failed.
