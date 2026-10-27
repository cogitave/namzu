---
'@namzu/sdk': minor
'@namzu/cli': patch
---

The model-written compaction summary is held to a total time limit and reads a transcript that tool output cannot forge. New optional `compaction.modelSummaryTimeoutMs` (default 120000) ends the summary call however steadily it streams and keeps the extracted summary; before this, only a stalled stream ended it. Lines in tool results, assistant text, attachments and call arguments that begin with `[` now have a backslash put before them in the transcript the small model reads, so a line like `[person]: ...` inside a tool result is not taken for a request. Nothing to change to keep working.

The part of the conversation being replaced goes to the small model, which may belong to another provider than the conversation; set `compaction: { modelSummary: false }` to keep it with one provider.
