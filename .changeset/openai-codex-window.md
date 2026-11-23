---
'@namzu/openai': minor
---

The subscription route (`CodexProvider`) now reads each model's context window from the account's model list. `listModels()` rows carry `contextWindow` when the backend sends one (`context_window_tokens`, `context_window`, `context_length`, `max_model_len` or `max_context_window`), scaled by `effective_context_window_percent` when it sends that, and the new `resolveContextWindow(model, signal)` reports it to the runtime. A listing that fails or hangs is skipped and never fails a turn. A subscription model that used to compact against a 128,000-token guess now compacts against its real window; to keep the old figure, set `compaction.contextWindowTokens` to `128000`.
