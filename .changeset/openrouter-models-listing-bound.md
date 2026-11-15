---
'@namzu/openrouter': patch
---

A slow OpenRouter model listing no longer holds up the model picker, the context-window lookup or the first `max` or `ultra` effort request: each read of `/models` gives up after 5 seconds. A lookup that gives up behaves as if the listing had no entry (the built-in window table and the `xhigh` effort apply), and the picker reports a timeout. HTTP 402, 403 and 404 answers from OpenRouter now carry the new SDK error kinds `credits`, `moderation` and `no_endpoints`; they need `@namzu/sdk` with those kinds.
