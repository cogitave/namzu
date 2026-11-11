---
'@namzu/sdk': minor
'@namzu/cli': patch
---

A long session no longer makes every turn slower and larger. In a 100-turn session against an instant model, CPU per turn at turns 91-100 fell from about 3 s to under 1 s and the live heap stopped growing by about half a megabyte a turn. Before, each turn re-read and re-verified the whole session log many times (once per stored checkpoint when choosing what to prune, several times when starting the turn, and on every evidence recall page), and every finished turn stayed in memory because it left a listener on the session's abort signal. Now those reads resume after the last record they folded and check that record against the file, so they read only what was appended; a log that no longer holds that record is read again from the start, with the same strict or tolerant behaviour as before. The first read in a process still verifies the whole chain.

Nothing to change for a caller: persisted records, resume, compaction and the content the model receives are the same, and aborting a session still aborts its running turn with the same reason. One behaviour is narrower: a byte altered in the middle of the log while a process runs, with the newest record left alone, is now noticed by the next process rather than the next turn. Additive: `CheckpointLogView` has an optional `pruneFacts(scope, checkpointIds)` that answers both retention questions in one read; a view without it is still asked the two separate questions.
