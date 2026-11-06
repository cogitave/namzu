---
'@namzu/openai': minor
---

`OpenAIProvider` now reports the context window a compatible endpoint declares (`resolveContextWindow`), so compaction measures against what the endpoint serves rather than the SDK's table entry for the model's name. Before, a 1M-token model reached through a custom `baseURL` under a name such as `deepseek-…` was held to the table's 64k and compacted about every 40k tokens. The listing is read from `context_window_tokens`, `context_window`, `context_length` or `max_model_len` (output limit: `maximum_output_tokens` or `max_output_tokens`), asked once per driver, and never fails a turn. OpenAI's own API is not asked. Nothing changes for a caller with no custom `baseURL`; one with a window set in config keeps it.
