---
'@namzu/cli': patch
---

After a compaction the model is told the session goal again (its state, how many automatic replies are used, and the objective cut at 600 characters, marked as of the compaction), and an ordinary turn now carries the plan file across a compaction as well; before, only a resumed turn and `/compact` did, because the turn runner dropped the note. Nothing to change on your side.
