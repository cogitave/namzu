---
"@namzu/cli": patch
---

Pressing Esc before the model has answered puts your message back in the box instead of leaving it in the transcript above "Interrupted"; once it has written anything, the message stays as before. A background command is named by what it does ("Run full test suite") rather than by its raw command line with the project path, in the finished row, in `/tasks` and in the job's detail; and the model's `next_offset` and temp-file line no longer shows under a job's output.
