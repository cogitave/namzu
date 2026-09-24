---
"@namzu/sdk": minor
"@namzu/cli": patch
---

Authorization rules can now match the owning toolset's source id with `{ type: 'by_source', sourceIdGlob: 'mcp:github', decision: 'review' }`. This lets a host ask, allow or deny every tool from one MCP server without listing names individually. A rule with no matching host-supplied source leaves the call to later rules.

The CLI's permissions display now shows source rules and their decisions.
