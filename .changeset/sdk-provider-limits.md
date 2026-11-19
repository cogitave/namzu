---
'@namzu/sdk': minor
---

Adds the optional `LLMProvider.readLimits(signal?)` and the `ProviderLimits`, `ProviderLimitWindow` and `ProviderLimitCredit` types, so a driver can report what its vendor says about the account (usage windows, credit left). A driver that does not implement it reads as "not reported"; nothing existing changes.
