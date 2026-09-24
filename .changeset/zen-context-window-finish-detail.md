---
'@namzu/zen': patch
---

A response routed to an Anthropic-backed model that fills the model's context window now carries `finishDetail: 'context_window'` alongside `finishReason: 'length'`. `@ai-sdk/anthropic` folds both `max_tokens` and `model_context_window_exceeded` into `unified: 'length'`, keeping the original word only on `finishReason.raw`, which the driver did not read; the runtime auto-continues a plain `'length'` finish, sending a reply that had just filled the model's context window straight back in, in a prompt now longer than the window it had just overflowed. A plain output-limit `'length'` (`max_tokens`) is unaffected.
