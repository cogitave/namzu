---
'@namzu/sdk': patch
---

Keep host-triggered compaction state intact when a conversation starts a fresh run.

`compactNow` and `compactRegion` now extract real structured state from the messages they replace instead of producing an empty summary when model verification is disabled. Their summaries are retained because no run-scoped state manager exists between queries to reproduce them.

Fresh `query()` calls restore compacted-context summaries and working-memory artifact ledgers after rebuilding the current system prompt, while continuing to discard arbitrary historical system messages. An inherited compaction summary remains pinned through later automatic compaction, including context-overflow retries and the final persisted run-message snapshot.
