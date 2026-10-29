---
"@namzu/sdk": patch
"@namzu/cli": patch
---

Clarify that the discovery catalogue is a snapshot, not live tool status. Call tools directly when their schemas are visible in the current runtime tools parameter; search only for a needed deferred schema that is absent. Loaded tools remain governed by source-bound history receipts, compaction resets, readiness, allow-lists and authorization.
