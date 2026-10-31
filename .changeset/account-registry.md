---
'@namzu/sdk': minor
---

Adds an account registry: several credentials for one provider, each session bound to one. `createAccountRegistry` keeps labelled API-key accounts and private Codex-home accounts in a new `accounts.json` under `NAMZU_HOME`; today's sign-in is always the provider's `default` account and `credentials.json` and `api-keys.json` are read as before. Adds the `account_bound` session-log record, `ProviderErrorCode` `usage_limit` (a spent allowance, not retried inside the turn; the classifier now maps `insufficient_quota` to it where it used to be a retryable `rate_limit`, so a host that matched on `rate_limit` for a spent allowance should also handle `usage_limit`) and a per-account refresh lock.

A session log that contains `account_bound` is refused by earlier builds; a session that stays on the default account never writes one. An exhaustive `switch` over `ProviderErrorCode` or over session record types needs a new case.
