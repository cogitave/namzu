---
'@namzu/openai': patch
'@namzu/anthropic': patch
'@namzu/deepseek': patch
'@namzu/ollama': patch
'@namzu/bedrock': patch
---

A response stream that closes without the provider's own end-of-response marker (a final finish reason, `message_stop`, a completed event, `done`) is now reported as a retryable network failure. Before, it ended quietly: a text answer that was cut short was accepted as complete, and a cut tool call reached the model as a cut-off call. Nothing changes for a stream that finishes. If you test a driver with a fake stream, end it with the marker.
