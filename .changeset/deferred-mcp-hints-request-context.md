---
'@namzu/sdk': major
---

`ToolManager.toPromptSection()` no longer includes server-authored description hints for deferred MCP tools. It still lists their names. If a host calls this method directly and relied on those hints in its system prompt, call `toUntrustedDeferredContext()` separately and put its labelled output in a request-only context message after history. The SDK query path does this automatically. MCP tools remain searchable by their descriptions through `search_tools`.
