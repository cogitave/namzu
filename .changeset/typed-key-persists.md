---
'@namzu/cli': minor
---

An API key typed into the terminal's provider picker is now kept for every provider that takes one, not only Gemini. Before, a DeepSeek, OpenAI, OpenRouter or Anthropic key lived in memory until quit and the next start asked for it again; now it is saved privately in `api-keys.json` (owner-only) after the provider starts, the provider choice is saved with it, and the next start uses it without asking. A pasted Anthropic subscription token is still session-only because it expires in hours. Environment variables still win over a saved key.

Run `/logout <provider>` (or `namzu logout <provider>`; `anthropic-key` for an Anthropic API key, since `anthropic` removes the subscription) to remove a saved key; `/logout all` now removes every saved key too. If a script relied on `logout all` leaving `api-keys.json` alone, remove only the providers you want to forget instead.

Keys that an earlier build kept only in `accounts.json` (added with `/auth`) are copied once, on first start, into the file startup reads, with a one-line notice; the accounts are unchanged. A key added with `/auth` also becomes the provider's startup key when it has none. Existing accounts, sign-ins, environment keys and labels behave as before.
