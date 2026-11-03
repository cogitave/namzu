---
"@namzu/openai": patch
"@namzu/deepseek": patch
"@namzu/http": patch
"@namzu/openrouter": patch
"@namzu/bedrock": patch
"@namzu/google": patch
"@namzu/zen": patch
---

A reply the service stopped with a content filter or safety block now sets `refusal: {}` on its finish chunk next to `finishReason: 'content_filter'` (OpenAI Chat Completions and Codex, DeepSeek, HTTP in both dialects, OpenRouter, Bedrock, Google including a blocked prompt, Zen). The finish reason is unchanged. `@namzu/sdk` reads the field to tell a declined request from an empty reply and no longer retries it as an empty completion; nothing else changes for these drivers.
