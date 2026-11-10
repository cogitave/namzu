---
'@namzu/sdk': minor
'@namzu/anthropic': patch
'@namzu/bedrock': patch
'@namzu/http': patch
---

`TokenUsage` gains an optional `fullPromptTokens`, the whole prompt of one call with cache reads and writes included, and `promptSizeOf(usage)` returns it (or `promptTokens` when a driver does not set it). The Anthropic and Bedrock drivers, and the HTTP driver's Anthropic dialect, report only the uncached remainder as `promptTokens`, so on a warm cache the context size, the compaction trigger and the context meter read 2 to 4 tokens for a context of tens of thousands; they now read the whole prompt, and a long conversation compacts when it should. Nothing you call changes: `promptTokens`, `cachedTokens`, `cacheWriteTokens` and cost are as before. A custom driver that keeps cache tokens out of `promptTokens` should set `fullPromptTokens` too.
