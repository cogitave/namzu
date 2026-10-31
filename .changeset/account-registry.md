---
'@namzu/sdk': major
---

Breaking: a spent allowance is no longer retried, and two unions gain a member. `ProviderErrorCode` gains `usage_limit`, and the classifier now maps the codes `insufficient_quota`, `usage_limit_reached`, `usage_limit_exceeded` and `billing_error` to it, and a `ProviderRequestError` that names a spent allowance (by provider code, or by an exhausted credit balance or quota in its own words) is `usage_limit` and not retried, where these were a retryable `rate_limit`. A caller that retried or waited on `rate_limit` for a spent allowance now gets `usage_limit` and no retry: handle it by switching account or telling the user the allowance is spent. An exhaustive `switch` over `ProviderErrorCode`, or over `SessionRecord` types (which gains `account_bound`), needs a new case to keep compiling.

Also adds an account registry: several credentials for one provider, each session bound to one. `createAccountRegistry` keeps labelled API-key accounts (each with an optional endpoint and starting model) and private Codex-home accounts (the codex provider only) in a new `accounts.json` under `NAMZU_HOME`; today's sign-in is always the provider's `default` account and `credentials.json` and `api-keys.json` are read as before. A session log that contains `account_bound` is refused by earlier builds; a session that stays on the default account never writes one.
