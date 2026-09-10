---
"@namzu/sdk": minor
"@namzu/openai": minor
"@namzu/cli": minor
---

Enable provider-hosted web search with `web.search: live` or `cached` in CLI configuration, or `webSearch: { mode: 'live' | 'cached' }` in SDK run/completion parameters. Search remains off by default. Currently the Codex subscription driver supports it; unsupported provider routes refuse explicitly. Hosted searches display activity and retain source links and native replay evidence without executing local shell commands. Enabling this setting authorizes server-side searches without per-search local-tool approval. Model token usage remains accounted in the enclosing request; separate search fees are not measured by the token ledger.

SDK event consumers can handle the new `hosted_tool` event (`hosted.tool` on SSE). These observations never request local tool execution.
