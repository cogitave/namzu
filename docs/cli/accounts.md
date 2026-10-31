---
type: Reference
title: Accounts in the terminal
description: /auth and namzu --account - choose which account a conversation uses, add a Codex sign-in or a labelled API key, rename or remove one, and what happens when an account runs out of allowance.
resource: packages/cli/src/tui/account-flow.ts
tags: [cli, tui, accounts, providers, credentials]
status: stable
generated: { by: process:claude-code, at: 2026-10-31T00:00:00Z }
---

# Accounts in the terminal

A provider can have more than one account on this computer. `/auth` chooses the
one a conversation runs on; other conversations, in this terminal or another,
keep theirs. Your usual sign-in stays exactly as it was: `/login`, `/logout`,
borrowed sign-ins and environment keys are unchanged, and the usual sign-in is
listed as the account called `default`. The model behind this is
[Accounts](../sdk/accounts.md).

## Choosing an account

`/auth` opens the accounts you can use, last used first: provider, name, and
whether it is ready, limited until a time, or needs signing in again. The one
this conversation is on is marked. Type to narrow the list, then press Enter.
The choice is used from the next reply (a reply already running is not
interrupted, and a choice made during one is applied when it ends), and it is
written into the conversation, so resuming it continues on the same account.
`/auth <name>` skips the list, `/auth add` goes straight to adding. A name that
two providers share is written `provider:name`.

The footer shows the account after the model (`glm-5.3-flash-uncensored · free-a`),
for a conversation on an account you added, and, so a switch back is visible, for
a provider that has any. A provider with only its usual sign-in shows nothing
extra. Choosing another provider's model by hand with `/model` leaves the account
behind. Saved preferences are never written by `/auth`.

## Adding an account

`/auth add` (or the last row of the list) offers two kinds.

- **Codex.** Name it, and Namzu runs the official `codex login` with a new private
  folder under the Namzu home (`accounts/codex/<name>/`). Finish in the browser;
  if no window opens, the address the tool printed is shown. Esc cancels and
  removes the folder. The account counts as added only when the tool finishes and
  left a usable sign-in. The same signed-in account cannot be added twice. Namzu
  never reads `~/.codex` for these.
- **API key.** Pick the provider, then an optional address (for a service that
  speaks the same API; a different address is a different account), the key (typed
  masked, never shown or logged), a name, and an optional starting model.

In the list, `ctrl+r` renames the highlighted account, `ctrl+x` removes it (after
a question; its key or sign-in is deleted from this computer), and `ctrl+a`
switches an API-key account to switch automatically (below). The account a
conversation is using, and the usual sign-in, cannot be renamed or removed here.
A name is 1 to 32 lowercase letters, digits or hyphens; `default` is taken.

## Starting on an account

```sh
namzu --account work
namzu --account openai:work
```

Like the other launch flags, this chooses the account for this launch only
([Launch flags](launch-flags.md)). It names the provider, so it cannot be combined
with `--provider` for another one. `ProviderChoice.account` in `preferences.json`
(`<provider>:<name>`) pins an account for a plain launch; absent means the usual
sign-in, so older files read as before.

## When an account runs out

When the provider says the allowance is spent (not that it is briefly busy), the
reply stops with a plain sentence and one quiet line under the composer:
`enter continue with another account · esc dismiss`. Enter opens the list, with
the other accounts first, and the same message runs again on the one you pick.
The account is shown as limited in every conversation's list until the time the
provider gave, or for an hour when it gave none. If there is no other account the
sentence points at `/auth` and `/model`.

Subscription accounts never switch by themselves. An API-key account can be set
to (`ctrl+a` in the list, off by default): on a spent allowance it moves to
another API-key account of the same provider that is not limited, says so, and
runs the message again.

## What is stored

`accounts.json` (keys and Codex folders), `account-activity.json` (last use,
limits, the automatic setting; no secrets) and `accounts/codex/` under the Namzu
home, all private to your user. A conversation records which account it is on with
an `account_bound` entry; a build older than this change refuses a conversation
that holds one, and a conversation that never leaves the usual sign-in never
writes one. If a conversation's account was removed, resuming it continues on the
usual sign-in and says so.
