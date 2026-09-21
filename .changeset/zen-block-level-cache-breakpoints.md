---
'@namzu/zen': patch
---

On the Messages protocol, a cache request now places block-level breakpoints —
after the static system text, and on the last message before request-only
context — instead of the request-level `cacheControl` option, which the native
adapter sends as a top-level `cache_control`. That is Anthropic's automatic
caching, which puts its breakpoint on the last block: the request-only context
at the tail, which the next request replaces, so no later request read the
cached history. Other protocols are unchanged.
