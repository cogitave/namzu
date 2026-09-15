---
"@namzu/sdk": patch
---

Three fixes to the bookkeeping behind the run suspend for a background job the model awaited. Nothing about when a run holds itself open changes; what changes is that the record of an exit no longer outlives the exit.

- **A job exit that has been read stops counting as pending work.** The record of an exit used to survive the notice that delivered it, gated only by whether anything at all was queued on the job-notice channel — so the next job to end, awaited or not, made that stale record read as news and bought the model a turn to re-read an exit it had already seen. The record is now dropped by the delivery that accounts for it.
- **A hold takes an exit only together with the notice that delivers it.** The delivery path took the exits first and asked for the text afterwards; on the branch that found none, the exits were already gone and nothing carried them. Neither is taken unless both are there.
- **An exit that lands while the run is settling is delivered, not lost.** An awaited job ending in the moment between the hold's grace expiring and the run finishing was delivered by nobody — the hold had already looked, `abandonedJobIds` could not honestly name a job that had finished, and the host's own between-turns announcer stays quiet while a run is in flight. It now arrives as the same `{ type: 'runtime-context', kind: 'job-exit' }` message on `Run.messages`, so the transcript has it and a continued thread opens with it.

No API is added or withdrawn. `NAMZU_JOB_HOLD_MAX_MS` is now read with the same parse the `NAMZU_JOB_WAIT_*` bounds use, which only makes an invalid value fall back to the two-minute default the way the others already did.
