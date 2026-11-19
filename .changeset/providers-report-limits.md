---
'@namzu/anthropic': minor
'@namzu/openrouter': minor
'@namzu/deepseek': minor
---

Each driver now implements `readLimits`: Anthropic answers from the subscription rate-limit headers of the last response (no extra request; `undefined` for an API key), OpenRouter reads the key's limit and use with one `GET /key`, and DeepSeek reads the balance with one `GET /user/balance` to its own host only. The parsers (`parseUnifiedLimits`, `parseKeyLimits`, `parseBalance`) are exported and return `undefined` for any shape they do not recognise. Additive; no existing call changes.
