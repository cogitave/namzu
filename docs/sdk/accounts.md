---
type: Reference
title: Accounts
description: More than one credential for one provider, chosen per session. The account registry, its additive accounts.json store, the account_bound session record and the usage_limit error code.
resource: packages/sdk/src/account/
tags: [sdk, accounts, credentials, providers, sessions]
status: stable
generated: { by: process:claude-code, at: 2026-10-31T00:00:00Z }
---

# Accounts

An account is a provider plus a label, written `<provider>:<label>` (`codex:work`,
`openai:team`). A label is 1 to 32 characters of lowercase letters, digits and
hyphens. The registry lets a host keep several accounts for one provider and bind
each session to one of them. It does not decide which account to use.

## The default account

Every provider has an account labelled `default`. It is today's sign-in for that
provider, read exactly as before: `credentials.json`, `api-keys.json`, the
environment and a borrowed credential file keep their meaning and are never
migrated, rewritten or deleted. `default` is synthesised on read and never stored,
so a provider needs no setup to have one account. The label `default` cannot be
added, renamed to or removed.

## Account kinds

| Source | Holds | Created by |
|---|---|---|
| `existing-default` | the provider's existing sign-in | synthesised |
| `codex-home` (codex provider only) | a private directory under `<NAMZU_HOME>/accounts/` whose `auth.json` a `codex login` wrote with `CODEX_HOME` pointing at it | `add({ kind: 'codex-home' })` |
| `api-key` | a labelled API key in the store's secret map | `add({ kind: 'api-key', apiKey })` |

A Codex directory has one owner, Namzu, so its tokens may be refreshed in place.
`add` refuses a directory outside `<NAMZU_HOME>/accounts/` and a directory another
account already uses. `remove` deletes the directory, never one outside that
folder.

## The store

`<NAMZU_HOME>/accounts.json` is additive and created on the first `add`:

```json
{ "version": 1, "accounts": [], "keys": {} }
```

It is written atomically with mode `0600`. An account names its key by an opaque
`keyRef`; the key itself lives only in `keys` and is not part of any listing or
log. Fields a newer build wrote are kept when this build rewrites the file. A
store that is not valid JSON or not version 1 is refused, never replaced.

## Registry

`createAccountRegistry({ home?, defaultProviders?, readers?, now? })` returns an
`AccountRegistry`:

- `list(provider?)`, `get(id)`: defaults first, then stored accounts in creation order.
- `add`, `rename`, `remove`: a mutation holds `accounts.json.lock` and is refused
  while another live owner holds it, after a short wait (`lockWait` replaces the
  wait). A lock whose recording process has exited is reclaimed on its own.
  A Codex directory may not equal, contain or sit inside another account's
  directory, symlinks are resolved before that check, and `remove` never deletes a
  directory that still holds another account's. Renaming changes
  the id, so a session bound to the old id falls back to `default`.
- `resolve(id, signal)`: returns a `ResolvedAccountCredential`, or throws
  `CredentialWithdrawnError` when the account or its credential is gone. Reading
  the existing sign-in and refreshing a Codex directory are supplied by the host
  through `readers`.
- `next(provider, excluding)`: the account to offer after a limit, skipping those
  already tried.

## Refresh lock

A reader that refreshes a Codex account takes `withAccountRefreshLock(dir, ...)`
around the whole read, refresh and write, and writes back only the token fields,
checking that the file still holds what it read. The lock file is
`<dir>/auth.json.namzu.lock`, one per account, so a stuck account never blocks
another. A lock whose recording process has exited is reclaimed; a lock held by a live
process is refused unless the caller passes `attempts` and a `wait` hook.

## Session binding

`account_bound` is a [session-log](session-log.md) record:
`{ accountId, provider, reason }` with `reason` one of `start`, `user_switch` or
`limit_switch`. It is written between turns, when a session is bound to an
account other than the provider's `default` and on each switch. Replay reads the
last one for the provider with `resolveBoundAccount(records, provider, registry)`.
If that account has since been removed the result is `<provider>:default` with
`fellBack: true`, so the host can say so and record a `user_switch`.

A build that predates this record refuses a log containing it. A session that
stays on the default account never writes one, so existing sessions stay readable
by older builds.

## usage_limit

`ProviderErrorCode` gains `usage_limit`: the account's allowance is spent until a
reset, as opposed to a burst limit (`rate_limit`). It is not retried inside the
turn. A fallback chain still advances past it, and the error catalogue explains
it as `provider.usage_limit`. The classifier maps the structural codes
`insufficient_quota`, `usage_limit_reached` and `usage_limit_exceeded` onto it, so a
spent allowance stops instead of being retried; burst limits stay `rate_limit`.
