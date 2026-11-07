---
'@namzu/openai': minor
---

`OpenAIProvider` now reads what a compatible endpoint's `/models` row states about a model, and reports its context window to the runtime (`resolveContextWindow`) so compaction measures against what the endpoint serves rather than the SDK's table entry for the model's name. Before, a 1M-token model reached through a custom `baseURL` under a familiar name was held to the table's 64k and compacted about every 40k tokens.

**What changes for a caller with a custom `baseURL`** (also one set by `OPENAI_BASE_URL`): the window the endpoint declares replaces the table's figure, and it can be lower as well as higher. A model picker row now shows its context, and the side-model chooser's tie-break on window, input kinds and price now sees what the endpoint declared. To keep the old behaviour, set the window in config (`compaction.contextWindowTokens`), which outranks the endpoint. A caller on OpenAI's own API, or with no custom `baseURL`, is unchanged, and OpenAI's own API is never asked.

What is read, where the listing states it outright: the window (`context_window_tokens`, `context_window`, `context_length`, `max_model_len`; the first that holds a positive integer), the output limit (`maximum_output_tokens`, `max_output_tokens`, `max_completion_tokens`, `top_provider.max_completion_tokens`), input kinds (`capabilities.vision`, else `input_modalities`, `architecture.input_modalities`, or `modalities` on a chat model), `capabilities.tools: false`, the effort menu (`supported_reasoning_efforts`, or `capabilities.reasoning_effort_values` with the names in `reasoning_effort_aliases`; `capabilities.reasoning_effort: false` is an empty menu) and a USD price per token (`pricing.prompt`, `pricing.completion`, as dollars per million). A default output length, a price in another currency and a menu listed as `null` are left unknown rather than guessed.

The window listing is asked for once per driver and kept; a failure is remembered for five minutes and a listing that takes more than three seconds is cut short, so an endpoint without a usable listing costs one request, not one per turn.
