---
'@namzu/sdk': major
---

`ToolManager.toPromptSection()` no longer includes server-authored description hints for deferred MCP tools. It still lists their names. If a host calls this method directly and relied on those hints in its system prompt, call `toUntrustedDeferredContext()` separately and put its labelled output in a request-only context message after history. The SDK query path does this automatically, bounds the hint list to 4,000 characters plus its provenance frame, prices the largest permitted rendering before step preparation and filters it to permitted tools. Hosts preparing their own steps can call `snapshotUntrustedDeferredContext()` for the same bounded snapshot. MCP tools remain searchable by their full descriptions through `search_tools`.
