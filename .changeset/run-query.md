---
'@namzu/sdk': minor
---

A run/session query seam, including what compaction removed.

The stores could each answer part of it and nothing could answer the question. `readEvents` gives a log; `writeMessages` persisted a history; and the two **disagree by design** once compaction has run — the persisted history is what survived, and what compaction removed lives only in the event log. "Show me this conversation" had two plausible answers and a caller picked one by accident.

The compacted-away half is the reason this exists. `compaction_shed` has carried "exactly the messages the pass removed, in their original order" since shed history was shadowed to the transcript, precisely so it would not be lost — and nothing read it back. Evidence nobody can retrieve is evidence nobody kept.

`RunQuery.shedHistory()` returns every pass, oldest first, with its iteration, its reason and its position in the log. `fullTranscript(messages)` returns everything that was ever in the conversation.

The ordering claim is exactly that and no more, and it is stated in the source: this does **not** reconstruct the original interleaving, and it cannot — the log records what each pass removed, not where the summary that replaced it sits relative to what came after. What it does guarantee is completeness, which is the question somebody reconstructing an incident is actually asking.

`status()` goes through the read model rather than folding the log a second time: two folds of one log are two chances to disagree, and a run that reads differently depending on which surface asked is what this seam exists to remove.
