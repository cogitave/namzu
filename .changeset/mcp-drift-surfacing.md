---
"@namzu/sdk": patch
"@namzu/cli": patch
---

MCP tool definitions that change after initial admission keep serving their earlier definition across turns; new and removed names still update. `/mcp` and `exec --json` now report server discovery changes and current policy refusals, including changed definitions held for review.
