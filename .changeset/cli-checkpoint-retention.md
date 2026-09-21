---
"@namzu/cli": major
---

Every turn the CLI starts keeps its newest 10 checkpoints instead of all of
them. That covers interactive turns, `namzu run`, resumed and drained turns,
and delegated child sessions. A turn takes a checkpoint every iteration plus
one per tool review, and nothing set a limit, so a long session kept every
one. On one machine that came to 19,014 checkpoint files and 6.33 GB.

**What changes for you.** Only the newest 10 checkpoint documents of each turn
stay in `<session-id>/checkpoints/`, and `namzu drain` reports at most that
many per turn. A checkpoint whose decision is still outstanding is never
pruned. Resuming is unaffected, because every resume reads the checkpoint it
was handed or the newest one. If you inspect intermediate checkpoints by hand,
copy them out while the turn is still going.
