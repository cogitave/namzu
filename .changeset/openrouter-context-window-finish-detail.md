---
'@namzu/openrouter': patch
---

A response whose upstream backend reports its own context-window-exceeded reason (Anthropic's `model_context_window_exceeded`, or the words other OpenAI-compatible backends use) via OpenRouter's `native_finish_reason` now carries `finishDetail: 'context_window'` alongside `finishReason: 'length'`. OpenRouter normalizes every backend's finish reason to one of five values, so a proxied model's context-window stop and its output-token-limit stop both used to report a plain `'length'` finish; the runtime auto-continues that, sending a reply that had just filled the model's context window straight back in, in a prompt now longer than the window it had just overflowed. A plain output-limit `'length'` is unaffected: `finishDetail` is set only when `native_finish_reason` names the model's context window.
