---
"@namzu/anthropic": patch
---

A request with `speed: 'ultrafast'` is now refused before it is sent, with a `bad_request` `ProviderRequestError` whose `providerCode` is `fast_mode_unsupported`, instead of being sent at standard speed. Ultrafast is not an Anthropic mode; use `speed: 'fast'` on a model that offers it, or leave `speed` out.
