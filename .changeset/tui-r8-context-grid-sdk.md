---
"@namzu/sdk": minor
---

Add `analyzeContextUsage`, which splits a context window into its parts (system prompt, tools, MCP tools and instructions, agents, memory files, skills, messages, free space and the compaction buffer) and sizes tool calls and results by tool name. Also adds `describeToolCatalogTokens` and `estimateTextTokens`. Nothing existing changes; a host that wants a "where did my context go" view can call these.
