---
'@namzu/sdk': major
---

The compaction record's `trigger` now also accepts `'idle'` (a conversation compacted while nobody was using it). Breaking for code that switches over `trigger` exhaustively, or narrows it to the earlier members: add a case for `'idle'` (or a default branch). The same release adds `compactSession({ trigger: 'idle' })`, optional `TokenUsage.cacheTtlMs` and `cacheWriteTtlTokens`, `CacheControl.ttl`, the `cacheTtl` provider capability, a `CacheClock` helper and an optional `cache` field on the `token_usage_updated` event; none of those changes behaviour for existing callers.
