---
"@namzu/anthropic": patch
---

The error a stalled stream raises now says the turn lifecycle can emit
`turn_failed`, where it said the run lifecycle could emit `run_failed`: the
event it names was renamed in `@namzu/sdk` 44. Only the `ProviderRequestError`
detail text changed; its `kind` (`network`) and `providerId` are the same. A
caller that matched the old sentence should match on `kind` instead.
