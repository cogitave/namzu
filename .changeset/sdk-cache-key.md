---
'@namzu/sdk': minor
---

`ChatCompletionParams` gains an optional `cacheKey`, a stable name for the conversation. The query loop sets it to the session id on every request; a driver with a cache-routing field may send it, and one without ignores it. Nothing changes for a caller or driver that does not read it.
