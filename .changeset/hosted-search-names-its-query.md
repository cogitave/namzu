---
"@namzu/sdk": minor
"@namzu/openai": minor
"@namzu/anthropic": minor
"@namzu/google": minor
---

A provider-hosted web search now says what it searched for. `StreamChunk.delta.hostedTool`, and so the `hosted_tool` session event and the `hosted.tool` SSE event, may carry `query` (the search query), `url` (a page the provider opened instead of running a query) and `results` (how many sources it reported). Codex fills them from the search call's action, Anthropic from the search block's streamed input and its result list, Google from the grounding metadata. Each field is optional and absent when the provider does not say; nothing that already reads `id`, `name` and `status` changes. A custom driver can start emitting them whenever it knows them.
