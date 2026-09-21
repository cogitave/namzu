---
"@namzu/cli": major
---

Every run the CLI starts keeps its newest 10 checkpoints instead of all of
them. That covers interactive turns, `namzu run`, resumed and drained runs, and
delegated children. A run takes a checkpoint every iteration plus one per tool
review, and nothing set a limit, so a long session kept every one. On one
machine that came to 19,014 checkpoint files and 6.33 GB.

**What changes for you.** Only the newest 10 checkpoint files of a run stay in
`sessions/<id>/runs/<runId>/checkpoints/`, and `namzu drain` reports at most
that many per run. A checkpoint whose approval is still outstanding is never
pruned. Resuming is unaffected, because every resume reads the checkpoint it
was handed or the newest one. Older checkpoints of runs already on disk are
pruned the next time that run writes one. If you inspect intermediate
checkpoints by hand, copy them out while the run is still going.

Checkpoints written by this version use the SDK's schema-3 format, which
references one stored history. An older `namzu` refuses to resume them. Finish
or drain paused runs before downgrading.

`namzu state` now counts a run's checkpoint history logs as checkpoint files.
