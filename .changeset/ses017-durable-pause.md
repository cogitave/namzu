---
"@namzu/sdk": minor
---

**Durable pause.** A run that stops for a human now survives the process it stopped in.

Until now a review was an in-process `await`: nothing about the pending request was persisted, so a paused run could only be answered by the process that paused it. Worse, resuming one destroyed it — the resume path repaired the still-unexecuted tool call into a "tool result missing" placeholder, because a pause and a crash were indistinguishable in the record. The call the human was asked to approve was silently rewritten into one that never ran.

A pending decision is now a persisted state machine (`pending → resolved → executing → settled`, plus `cancelled`) carried on the checkpoint, addressed by an opaque single-use resume token. Reaching a review parks the run and returns; the process is free. Answering it records the outcome and resumes from the checkpoint.

Resume re-enters at the continuation point. A dispatcher applies the decision to the exact tool-call block it belongs to — before compaction, before any model call, and before the repair that used to destroy it — then finishes the interrupted iteration rather than starting a fresh one. A batch is never re-run because a human took an hour.

A crash mid-batch is recovered from a per-call execution journal rather than guessed at: calls recorded as settled keep their results, and calls that started but never settled are surfaced as "may have already run" instead of being re-executed. Exactly-once for arbitrary side effects is not something any system delivers; namzu is at-least-once at the batch boundary and says so.

The in-process `ResumeHandler` is unchanged and remains the fast path for SDK embedders.
