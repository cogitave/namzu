---
'@namzu/cli': major
---

`namzu logout` with no target, `namzu logout all` and `/logout all` now also delete `api-keys.json`, the file the Desktop's Settings > Models writes its keys to. Before, `all` removed only the sign-in files and the Google key, so a key pasted in the Desktop survived it. If you want that to stay, remove only the providers you want to forget: `namzu logout claude`, `codex`, `gemini`, or `<provider>` for one saved key (`anthropic-key` for an Anthropic API key, since `anthropic` removes the subscription).

An API key typed into the terminal's provider picker is now kept for every provider that takes one, not only Gemini. Before, a DeepSeek, OpenAI, OpenRouter or Anthropic key lived in memory until quit and the next start asked for it again; now it is saved privately in `api-keys.json` (owner-only) after the provider starts, the provider choice is saved with it, and the next start uses it without asking. A pasted Anthropic subscription token is still session-only because it expires in hours. Environment variables still win over a saved key.

Keys that an earlier build kept only in `accounts.json` (added with `/auth`) are copied once into the file startup reads, with a one-line notice; the accounts are unchanged, and a copy that failed is retried at the next start. A key added with `/auth` also becomes the provider's startup key when it has none. Removing the account does not remove that startup key; run `/logout <provider>`.
