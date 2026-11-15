---
'@namzu/sdk': minor
'@namzu/cli': patch
---

`ProviderErrorKind` gains three members: `credits` (HTTP 402, no credit left), `moderation` (HTTP 403 whose body names moderation or a flagged input) and `no_endpoints` (HTTP 404 whose body says no host can serve the request). Before, a 402 and that 404 were reported as `bad_request` and a moderation 403 as `auth`. None is retried. If you switch exhaustively over `ProviderErrorKind`, add the three cases; a 403 without a moderation body is still `auth`, and any other 404 is still `bad_request`. In the terminal an account with no credit now reads "has no credit left" instead of "could not process this message".
