---
type: Reference
title: Web search
description: Explicit provider-hosted search, activity events, and retained source links.
resource: packages/cli/src/tui/agent.ts
tags: [cli, sdk, providers, web]
---

# Web search

Web search is enabled by default for main conversations, independently of the
selected provider/model. The default `web.backend: auto` prefers provider-hosted search when the active
driver declares support and the session has no fallback chain. Otherwise Namzu
mounts an Exa-backed `web_search` tool using its existing MCP client.
Explicit `native` or `exa` selections are respected. Provider switches rebuild
the selection; a mixed fallback chain uses the common tool. Connections are lazy: starting Namzu sends no search query.
Each invocation sends the query to Exa and follows normal network-tool permission
review. Results contain source URLs and excerpts, treated as untrusted content.

Configure `$NAMZU_HOME/config.yaml` (normally `/home/arda/.namzu/config.yaml` on
this machine):

```yaml
web:
  search: off
```

This restores the previous disabled default. `search: live` is the default;
`backend: auto` is the default backend. Exa is independent of OpenCode installation. The public service worked without an API
key in validation, but has free-tier limits and may reject or throttle requests.
See the [official Exa MCP documentation](https://exa.ai/docs/reference/exa-mcp).
No auxiliary language model is invoked for search.

`web.fetch` remains off by default and independently enables guarded URL fetching.
`/status` shows the configured search mode; it is not a connectivity probe.

For provider-hosted search, explicitly choose `web.backend: native` and
`web.search: live` or `cached`. Cached mode implies native when backend is omitted;
Exa plus cached is rejected because Exa may fetch live pages. Currently only the
Codex subscription driver declares native support. Other native routes fail
explicitly; use the default Exa tool with those providers. Native search executes
inside the provider request, without a local-tool approval prompt. The following
native protocol details apply to that optional backend.

The CLI displays search activity and completion. URL annotations missing from the
answer's text are appended as a Sources list. Native response items, including
search calls and annotations, remain in the assistant's provider replay state;
matching-route continuation reuses them. Cross-provider continuation retains the
readable answer and source links, not another provider's private protocol items.
Retrieved content remains untrusted data.

SDK callers opt in through `AgentRunConfig.webSearch` or direct
`ChatCompletionParams.webSearch`, with `{ mode: 'live' }` or `{ mode: 'cached' }`.
Drivers explicitly declare `supportsHostedWebSearch`. Hosted work emits
`StreamChunk.delta.hostedTool`, translated to durable `hosted_tool` run events
and `hosted.tool` SSE events. These are observations, never executable tool calls.
A2A exposes the resulting answer rather than a separate hosted-activity event.

Once hosted activity begins, provider fallback cannot restart that request on a
second provider. Cancellation still aborts the enclosing model request. Ordinary
model token usage is accounted from the same response; the token ledger does not
claim to measure separate hosted-search fees. Forced closing summaries do not
start further searches. Run resumes use the current host's configuration.

Protocol reference: [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search).
