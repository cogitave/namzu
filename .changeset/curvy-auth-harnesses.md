---
'@namzu/cli': major
'@namzu/openai': minor
---

Reuse usable Claude and Codex device sessions before asking for a new credential, add a selectable Namzu-owned login for both subscriptions, and keep API keys optional. Bare `namzu login` no longer starts Claude implicitly; run `namzu login claude` or `namzu login codex`, or choose the provider from the interactive `/login` screen.

Add the account-routed `CodexProvider` and `registerCodex()` Responses transport to `@namzu/openai`. Hosts supply a user-authorized access token and ChatGPT account id, and remain responsible for discovery, refresh and persistence.
