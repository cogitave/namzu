---
'@namzu/sdk': minor
---

A provider chain now leaves a member that answers "overloaded" (529 or 503) three times in a row and asks the next member, instead of spending the member's whole retry budget first (eleven tries in the terminal's policy). The `fallback` notice says which model was left and after how many answers. Rate-limit answers are not counted, one overloaded answer followed by a success changes nothing, and a lone provider or the last member of a chain keeps its whole budget. New option `ProviderRetryConfig.overloadedFallOverAfter` (pass it in `query({ retry })`); set it to `0` to keep the old behaviour of retrying the full budget before the chain moves on.
