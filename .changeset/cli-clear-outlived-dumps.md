---
"@namzu/cli": major
---

When a turn completes, the CLI deletes the crash dumps in that session's
`runs/emergency/` that are older than the turn. An interrupted turn or
`namzu run` writes one, holding the whole conversation. The CLI never resumes
from it, since the next turn continues under a new run id, so every interrupt
used to leave one on disk for good.

**What changes for you.** A dump no longer outlives the next completed turn of
its session. To keep one for inspection, copy it out of
`sessions/<id>/runs/emergency/` before sending another message. A dump written
after the turn started, or in a session whose turn did not complete, is kept.
