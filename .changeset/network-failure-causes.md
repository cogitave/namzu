---
"@namzu/sdk": minor
---

Failures on the way to a provider are now told apart: a proxy that answers the tunnel request with a refusal (407 asks for credentials) and a certificate the process does not trust are classified as non-retryable `network` failures, and the error catalog explains them with `provider.proxy_auth`, `provider.proxy_refused` and `provider.untrusted_certificate`. New exports: `readTransportCause`, the `TransportCause` type, and an optional `transport` field on `ErrorFacts`. A custom rule list that matched these failures through `provider.network` or an unknown code will now see them under the new rules; ordinary dropped connections are unchanged.
