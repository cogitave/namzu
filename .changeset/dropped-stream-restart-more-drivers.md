---
'@namzu/zen': minor
'@namzu/openrouter': minor
'@namzu/lmstudio': minor
'@namzu/google': minor
'@namzu/http': minor
---

A response stream that closes without the provider's own end-of-response marker (a final finish reason, `message_stop`, a terminal stop reason) is now reported as a retryable network failure. Before, it ended quietly or as a plain error: a text answer that was cut short could be accepted as complete, and a cut tool call reached the model as a cut-off call. A stream that ends with its marker is unchanged.

This reaches servers behind these drivers: an endpoint that closes a finished answer with only `[DONE]` and never sends a finish reason (`@namzu/openrouter`, `@namzu/http` on the OpenAI dialect) used to read as a finished answer and is now retried, and after the retries are spent the turn pauses. If your server behaves that way, make it send a finish reason on the last chunk. `@namzu/http` on the Anthropic dialect now requires `message_stop`. `@namzu/lmstudio` treats a reply with no stop reason, or one that stopped because the model failed or was unloaded, as cut. If you test a driver with a fake stream, end it with the marker.
