---
'@namzu/openai': minor
'@namzu/anthropic': minor
'@namzu/deepseek': minor
'@namzu/ollama': minor
'@namzu/bedrock': minor
---

A response stream that closes without the provider's own end-of-response marker (a final finish reason, `message_stop`, a completed event, `done`) is now reported as a retryable network failure. Before, it ended quietly: a text answer that was cut short was accepted as complete, and a cut tool call reached the model as a cut-off call. A stream that ends with its marker is unchanged.

This also reaches servers that speak the OpenAI wire (`@namzu/openai` is the driver behind several hosted and local endpoints): one that closes a finished answer with only `[DONE]` and never sends a finish reason used to read as a finished answer and is now retried, and after the retries are spent the turn pauses. If your server behaves that way, make it send a finish reason on the last chunk. If you test a driver with a fake stream, end it with the marker.
