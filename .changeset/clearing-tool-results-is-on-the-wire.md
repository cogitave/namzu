---
'@namzu/sdk': minor
'@namzu/cli': minor
---

New run event `compaction_tool_results_cleared`, carrying `clearedCount`, `charsReclaimed`, `reclaimedTokens` and `reliefWasEnough`. It reaches the SSE stream as `compaction.tool_results_cleared`, the run reporter, `transcript.jsonl`, and the CLI's context line. A2A maps it to `null` alongside the other two compaction events: which of this runtime's context-relief strategies fired is a property of how it manages its own window, and a peer modelling a task lifecycle can act on none of them.

Clearing oversized tool results is the cheapest and most common context-relief path, and it was the only one that emitted nothing. It edits the conversation irrecoverably — `tool_result` bodies are replaced in place — so a host reading a transcript saw results it no longer had and no record of why, while both summarization outcomes were already on the wire.

It fires on **both** branches. `reliefWasEnough: false` means the clear happened, was insufficient, and a summarization followed: the history took two edits in one pass, and a reader who saw only the `compaction_completed` would attribute the whole loss to it.
