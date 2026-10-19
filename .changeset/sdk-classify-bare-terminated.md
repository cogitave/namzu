---
"@namzu/sdk": patch
---

`classifyProviderError` now classifies undici's `TypeError: terminated` (a response body the peer cut mid-stream) as `network` wherever it sits on the cause chain. Before, it was `unknown` and so not retried whenever a vendor SDK had dropped the socket error that normally travels with it as the cause. Such a cut is now retried with the usual backoff and `provider_retry` notice instead of ending the turn. A plain `Error('terminated')` is unaffected. Nothing to do to take this.
