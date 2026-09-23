---
'@namzu/cli': patch
---

`/abandon`, `/resume` and Abandon on a parked scheduled run no longer print the turn's id. They say `Stopped the paused turn. Your next message starts a new one in this conversation.`, `Continuing where it paused…` and `Stopped this run. The job stays scheduled.` Nothing else changes.
