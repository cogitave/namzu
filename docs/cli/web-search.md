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
mounts an Exa-backed `web_search` tool using a stateless MCP request.
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

Common search sends one `tools/call` request per attempt, without a fresh MCP
initialization handshake. Parent and child searches share a process-local queue
with at least 500 ms between request starts. HTTP 429, 502, 503 and 504 receive
at most three total attempts, honoring `Retry-After` or exponential backoff with
jitter. Queueing, network requests and retries share a 25-second deadline;
operator cancellation aborts waiting and active requests. Progress reports show
queueing and rate-limit waits. A cooldown longer than the remaining deadline
returns a failure with retry guidance, not fabricated results. This limits local
bursts; it does not guarantee availability or coordinate separate CLI processes.
Responses are bounded to 1 MiB and retain source links and untrusted provenance.

`web.fetch` remains off by default and independently enables guarded URL fetching.
`/status` shows the configured search mode; it is not a connectivity probe.

For provider-hosted search, explicitly choose `web.backend: native` and
`web.search: live` or `cached`. Cached mode implies native when backend is omitted;
Exa plus cached is rejected because Exa may fetch live pages. Native support is resolved against the driver, selected model and mode:

- Codex subscription supports live and cached search.
- Anthropic's direct Claude API route supports live search for the recognized
  Claude model families. Compatible proxy URLs and cached mode are not admitted.
- Google's API-key route supports live grounding with function tools on the
  Gemini 3 models enumerated by `supportsGoogleSearch` in the driver. Code Assist
  sessions, older models and cached mode keep the common backend under `auto`.
- Zen and other drivers without native search mapping keep Exa. A model name or
  Responses-compatible endpoint alone is not evidence of hosted search support.

Native search is not auto-selected for structured-output sessions. An explicit
unsupported native request fails rather than silently changing backend or mode.
Provider account quotas and organization settings can still reject a request.
Subagents resolve search against their own route; a restricted specialist roster
without web search does not gain hosted network access. Common result previews
omit the internal provenance wrapper; the model and durable raw result retain it. Native search executes
inside the provider request, without a local-tool approval prompt. The following
native protocol details apply to that optional backend.

The CLI displays search activity and completion. URL annotations missing from the
answer's text are appended as a Sources list. Native response items, including
search calls and annotations, remain in the assistant's provider replay state;
matching-route continuation reuses them. Cross-provider continuation retains the
readable answer and source links, not another provider's private protocol items.
Retrieved content remains untrusted data.

SDK callers opt in through `ReactiveAgentConfig.webSearch`, `AgentRunConfig.webSearch` or direct
`ChatCompletionParams.webSearch`, with `{ mode: 'live' }` or `{ mode: 'cached' }`.
Drivers explicitly declare `supportsHostedWebSearch` and may refine it with
`supportsHostedWebSearchFor(model, mode)`. Retry/idle-timeout decorators preserve
that refinement, and fallback chains require support from every selected member.
Hosted work emits
`StreamChunk.delta.hostedTool`, translated to durable `hosted_tool` run events
and `hosted.tool` SSE events. These are observations, never executable tool calls.
A2A exposes the resulting answer rather than a separate hosted-activity event.

Once hosted activity begins, provider fallback cannot restart that request on a
second provider. Cancellation still aborts the enclosing model request. Ordinary
model token usage is accounted from the same response; the token ledger does not
claim to measure separate hosted-search fees. Forced closing summaries do not
start further searches. Run resumes use the current host's configuration.

Protocol reference: [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search).

Anthropic replays complete search content blocks on an unchanged matching route,
including encrypted results and citation indices. Modified text, tool calls or
reasoning invalidate this private replay; portable answer text and source links
remain available. A server `pause_turn` is reported as unfinished, not a complete
answer; automatic multi-request continuation of that stop reason is not implemented.
Google grounding sources are appended as links when missing from the answer.

References: [Anthropic web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool),
[Google grounding](https://ai.google.dev/gemini-api/docs/google-search).
