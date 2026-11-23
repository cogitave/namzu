---
'@namzu/openai': minor
---

The subscription route (`CodexProvider`) now reads each model's context window and compaction limit from the account's model list, the way the backend defines them. `listModels()` rows carry `contextWindow` (`context_window`, else `max_context_window`, times `effective_context_window_percent` with 95 when the row omits it, so a row with no percent now reports 95% of its window) and `autoCompactTokenLimit` (`auto_compact_token_limit` held to 90% of the window, or 90% when the row sends none). The new `resolveContextWindow(model, signal)` and `resolveAutoCompactLimit(model, signal)` report them to the runtime; counts sent as numeric strings are read. A listing that fails or hangs is skipped and never fails a turn. A subscription model that used to compact against a 128,000-token guess now compacts against its real window; to keep the old figure, set `compaction.contextWindowTokens` to `128000`. Other compatible hosts are unchanged.
