---
'@namzu/cli': minor
'@namzu/anthropic': minor
'@namzu/bedrock': minor
---

Compact a large conversation that nobody is using just before its one-hour prompt cache expires, so coming back does not re-write the whole context. Off by default: nothing changes until you set `compaction.idleCompaction: true` (and `compaction.promptCacheTtl: 1h`, because only a one-hour cache is worth it) in the config file. `compaction.idleCompactionMinTokens` (default 200,000) and the `NAMZU_IDLE_COMPACT_MIN_TOKENS` variable set the smallest context worth it. A one-hour cache costs more per write than the five-minute default, which stays the default.

Additive for callers: `@namzu/sdk` adds optional `TokenUsage.cacheTtlMs` and `cacheWriteTtlTokens` (per call, never summed), `CacheControl.ttl`, the `cacheTtl` provider capability, a `CacheClock` helper, an optional `cache` field on the `token_usage_updated` event, and `compactSession({ trigger: 'idle' })`. (The widened `trigger` union is in its own `@namzu/sdk` major changeset.) `@namzu/anthropic` and `@namzu/bedrock` take `promptCacheTtl: '5m' | '1h'` (Bedrock sends `1h` only to Claude 4.5 and later) and report the lifetime the service wrote.
