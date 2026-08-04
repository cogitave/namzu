---
'@namzu/sdk': minor
---

An OAuth2 connector no longer reaches the upstream unauthenticated.

`'oauth2'` was grouped with `'none'` and `'custom'` in the HTTP connector's header resolver, returning no headers. Every other auth type throws on a missing credential; this one quietly did not, so a connector configured for OAuth2 sent its request with no credential at all. The upstream's 401 then reads as a bad token rather than as no token, which sends whoever is debugging to look at the token.

An access token supplied in `credentials.accessToken` (or `token`) is now sent as a bearer. Without one the connector **refuses**, naming what is missing.

The token exchange itself is deliberately not implemented here: a client-credentials or authorization-code flow needs a token endpoint, refresh handling and somewhere to keep the result, none of which belong in a request-header helper. What is supported is the case a connector config can express today — a token the host already holds.

`'custom'` keeps returning nothing, and that is not the same omission: it means the host attaches its own headers, so there is nothing to leave out and nothing to refuse.

**Three connector declarations are now documented as not consulted** rather than left to be discovered. `ConnectorTrigger` and `ConnectorDefinition.triggers` are declared and unimplemented — no inbound event starts a run — and the note says what the missing half actually needs: cross-process de-duplication of a retried webhook, which requires a compare-and-set claim that this repo's only durable write primitive (an atomic file replace, last-writer-wins) cannot express, plus a release path so a claim held by a process that dies does not drop the event forever. It also names the two existing pieces to reuse rather than rebuild. `ConnectorMethod.outputSchema` is unread, with a pointer to how the tool layer already solved the same problem. `ConnectorDefinition.supportedAuth` is unchecked, with a note that the right place to check it is instance creation, not request time.
