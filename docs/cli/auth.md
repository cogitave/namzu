---
type: Reference
title: namzu auth
description: Sign in to a provider subscription, sign out, and list which credentials this machine has, whether each is usable or expired, without printing any secret.
resource: packages/cli/src/commands/auth.ts
tags: [cli, credentials, auth]
status: stable
generated: { by: process:agent, at: 2026-11-23T00:00:00Z }
---

# namzu auth

```text
namzu auth login <claude|codex> [--no-browser] [--code <value>] [--timeout <seconds>]
namzu auth logout [claude|codex|gemini|<provider>|all]
namzu auth status [--json]
```

`namzu auth login` and `namzu auth logout` are what `namzu login` and `namzu logout`
were; the options are the same. How a sign-in is kept, and how to finish one from a
shell that cannot paste, are on [Provider credentials and private state](credentials.md).
Typing the old names prints one line naming the new form and exits 64.

## namzu auth status

Lists each credential Namzu stores or detects, one row each:

```text
Credentials:
  anthropic    subscription sign-in   signed in with Namzu                   usable
  openai       environment variable   OPENAI_API_KEY                         usable
```

- **provider** is the provider id (`anthropic`, `codex`, `openai`, ...).
- **kind** is `subscription sign-in`, `API key` or `environment variable`.
- The third column says where the credential comes from in words: the name of the
  environment variable, `signed in with Namzu`, `saved by Namzu`, or a session another
  program keeps on this machine. It is never a token, a key, any part of one, or an
  account id the provider issued.
- **state** is `usable` or `expired`. A sign-in whose access token has lapsed is still
  usable when it carries a refresh token, because it renews itself on the next use.
  An expired sign-in needs `namzu auth login <provider>` again.

Local model servers and the anonymous free option are not credentials and are not listed.

The exit status is 0 when at least one credential is usable and 1 when none is, so a
script can ask `namzu auth status >/dev/null`. With `--json` the same rows are printed as
one JSON array of `{ provider, label, account, kind, state }`, with `kind` one of
`subscription`, `api-key`, `environment` and `state` one of `usable`, `expired`.
