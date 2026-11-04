---
"@namzu/sdk": patch
"@namzu/deepseek": patch
"@namzu/http": patch
"@namzu/openrouter": patch
"@namzu/bedrock": patch
"@namzu/zen": patch
---

A run could end with `HTTP 400: Invalid assistant message: content or tool_calls must be set` right after the model made a call that was denied or failed and then answered with nothing (no text, no call). The empty reply stayed in the history and went back to the provider in the next request. The loop no longer puts a reply with no text, call, reasoning or citation into a request. The DeepSeek, HTTP (both dialects), OpenRouter, Bedrock and Zen (chat lane) drivers also leave out an assistant entry that has neither text nor a tool call, and no longer send an empty `tool_calls` array. A call and its result are always kept together, the stored history and its reasoning are unchanged, and the HTTP anthropic dialect and Bedrock no longer send an empty reply as the text `"null"`. Nothing to do.
