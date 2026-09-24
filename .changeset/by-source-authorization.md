---
"@namzu/sdk": minor
"@namzu/cli": patch
---

Authorization rules can now match the owning toolset's source id with `{ type: 'by_source', sources: ['mcp:github'], decision: 'review' }`. This lets a host ask, allow or deny every tool from one or more MCP servers without listing names individually. A rule with no matching host-supplied source leaves the call to later rules.

The CLI accepts `[permissions.sources]` with source ids or globs mapped to `allow`, `ask` or `deny`, and its permissions display shows those rules and their decisions.
