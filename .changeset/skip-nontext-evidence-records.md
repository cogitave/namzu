---
"@namzu/sdk": minor
"@namzu/cli": patch
---

Add optional writer-owned `PersistedRunEvent.previousTextRecord` links for live
text retrieval. Bounded searches can reach earlier observations without spending
their record allowance on intervening nontext lifecycle events. Operational JSONL
records and adjacent links remain intact. Missing text links retain adjacent
traversal, and malformed content or incomplete history cannot be skipped as if
the archive were complete.

The CLI's opt-in automatic evidence recall benefits from these links within its
existing page and byte limits. No extra model call or tool action replay is used.
This is selected-text integrity checking, not a full audit of skipped operational
records; the `compaction.recallEvidence` default remains off.
