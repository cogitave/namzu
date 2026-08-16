---
'@namzu/sdk': minor
---

A compaction no longer deletes its own evidence. A new `compaction_shed`
run event carries exactly the messages a pass removed.

`compaction_completed` carried counts and nothing else, both shed sites
replace the live message array, and `persist()` writes `messages.json`
wholesale afterwards — so what a pass removed existed nowhere: not in
memory, not on disk, not in the transcript. "What did the agent decide
three compactions ago" was unanswerable, an undo had no input, and a search
index over run history could never see the part that mattered most.

Emitted BEFORE the array is replaced, at both shed sites — the structured
pass and the host-supplied-reducer path. `transcript.jsonl` is append-only
and `emitEvent` reaches it synchronously with the pass, so the record is
durable before the deletion is; emitted after, a crash between the two
loses exactly what this keeps.

The event carries whole message bodies including tool output, so both the
SSE and A2A mappers decline it: a subscribed client receives no frame with
shed content in it. The run reporter ignores it too.

`compactionConfig.recordShedHistory` defaults to `true` and turns it off
for an operator with a transcript-size constraint. That is a real trade —
the transcript grows by roughly what the compaction saved, since keeping
the bodies is the point.

This does not change the model that the message array is the source of
truth for a live run; it adds a parallel append-only record beside it.
