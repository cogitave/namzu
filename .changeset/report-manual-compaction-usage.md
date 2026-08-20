---
'@namzu/sdk': minor
'@namzu/cli': patch
---

Return exact verifier token usage from `compactNow` and `compactRegion`. Every non-null `CompactionResult` now includes `usage`; an all-zero record means the pass made no verifier request. Hosts that account for provider work should include this record in their own ledger.

After `/compact`, remove the old context-fill gauge only after the replacement conversation has been durably published. A pending or failed replacement keeps the old transcript and measurement; a successful replacement remains unmeasured until the next model request reports the new context size.
