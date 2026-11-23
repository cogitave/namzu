---
'@namzu/openai': patch
---

The subscription (Codex) route now sends a per-conversation `prompt_cache_key` and `session_id` header when the caller provides `cacheKey`, and keeps only the opening system messages in `instructions`. A system message later in the list (a step's changing guidance) is sent in place as a developer message instead of being joined into the front of the request, so consecutive requests share their opening bytes and the prompt cache is read again. No exported name changes.

If the subscription backend answers HTTP 400 naming the `developer` role, `input[...]`, `session_id` or `prompt_cache_key`, the request is resent once in the previous shape (all system text in `instructions`, no `session_id` header) and later requests in the process keep that shape. No other error is retried. Nothing for a caller to do.
