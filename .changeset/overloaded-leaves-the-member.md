---
'@namzu/sdk': minor
'@namzu/cli': patch
---

New option `ProviderRetryConfig.overloadedFallOverAfter` (pass it in `query({ retry })`): with a provider chain declared, a member that answers "overloaded" that many times in a row is left and the next member is asked, instead of spending the member's whole retry budget first. An answer counts when its classified code is `overloaded` (a 529, a 503, or a message that says so); rate limits are not counted. The option is off by default, so nothing changes for an existing `fallbackProviders` caller. The last member of a chain and a lone provider always keep the whole budget. The `fallback` notice names the model left and the count. The terminal now sets it to `3` (it used to retry eleven times on a saturated member before moving on); a finite `limits.tokenBudget` still stops the turn at the first 5xx without usage, so early fail-over only applies to turns without a token limit, which is the terminal's default.
