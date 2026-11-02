---
'@namzu/sdk': minor
---

A model id ending in `[1m]` (any case) now resolves to a window of at least 1,000,000 tokens, recognised or not, and `withModelWindowSuffixStripped(provider)` hands the driver the bare id; `stripModelWindowSuffix`, `splitModelWindowSuffix` and the pricing lookup ignore the suffix too. `NAMZU_DISABLE_1M_CONTEXT` switches it off. `parseAutoCompactWindow` and `resolveAutoCompactWindowSetting` read `786k`, `200000` and `1m` and clamp to 100k..1M. The hand table now gives exactly `deepseek-v4-flash`, `deepseek-v4-pro` and `deepseek-flash` 1,000,000 (they were 64,000, which put the first summary at 32,000 tokens), with or without a gateway prefix such as `deepseek/` and a `:tag`; any other id containing `deepseek`, a derivative like `deepseek-flash-lite` included, keeps 64,000. A host that depended on the old 64,000 for those three ids sets `contextWindowTokens`.
