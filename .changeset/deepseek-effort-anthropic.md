---
'@namzu/anthropic': minor
---

New config `compatibleEndpoint: true` for a `baseURL` that is an Anthropic-compatible third-party service. With it, an `authToken` is a plain bearer token: the subscription beta headers, the subscription user-agent and the identity system block are not sent, a non-Claude model id offers `low`, `high` and `max` effort, and `listModels` has no offline vendor menu to fall back to. It is off by default, so a token sent through a proxy keeps exactly what it sent before. New export `isVendorEndpoint(baseURL)` for callers deciding whether to set it.
