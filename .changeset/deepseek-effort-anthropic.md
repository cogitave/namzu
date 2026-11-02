---
'@namzu/anthropic': minor
---

An `authToken` with a `baseURL` that is not `api.anthropic.com` is now a plain bearer token: the subscription beta headers, the Claude Code user-agent and the identity system block are no longer sent to that host (set no `baseURL`, or the vendor host, to keep them). A non-Claude model id on such an endpoint offers `low`, `high` and `max` effort, and `listModels` no longer falls back to the vendor's offline menu there. New export `isVendorEndpoint`.
