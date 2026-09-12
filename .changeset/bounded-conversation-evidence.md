---
"@namzu/sdk": minor
"@namzu/cli": patch
---

Recover original oversized tool text in ordinary conversations after compaction or restart. `search_conversation` and `read_conversation` now use authenticated retained output for closed scoped runs while preserving assistant-message and compaction-history search. Search results can provide a UTF-8 byte position for reading near a match; returned character positions remain UTF-16. Missing or changed originals are explicitly unavailable, and partial legacy records remain previews.

The SDK adds `createDiskRunTextEvidenceSource` and its public types, a bounded text view alongside the existing tool-only evidence source, plus an optional smaller per-operation read ceiling. New spill manifests record character positions without changing the existing tool-only source interface.

Headless `run --resume`/`--continue` and persistent `run-stream --session` now receive conversation retrieval tools. Both search and read remain available with deferred tool loading. Hosts still authorize the invoking conversation; no tool is replayed to recover its result.
