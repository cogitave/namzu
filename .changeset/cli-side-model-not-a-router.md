---
'@namzu/cli': patch
---

The small model that writes titles and other side requests is no longer a random model on OpenRouter. With no `smallModel` set, an OpenRouter conversation could send its title to `openrouter/auto`, which picked a reasoning model that spent 1,273 tokens on a five-word title. Routers, music and video models and `:batch` variants are skipped, and the conversation's own vendor is searched first (a conversation on an Anthropic model gets that vendor's cheapest model). Set `smallModel` to choose one yourself.
