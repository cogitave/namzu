---
'@namzu/openai': patch
---

The subscription (Codex) route now sends a per-conversation `prompt_cache_key` and `session_id` header when the caller provides `cacheKey`, and keeps only the opening system messages in `instructions`. A system message later in the list (a step's changing guidance) is sent in place as a developer message instead of being joined into the front of the request, so consecutive requests share their opening bytes and the prompt cache is read again. No exported name changes.
