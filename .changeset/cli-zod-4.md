---
'@namzu/cli': minor
---

The CLI now runs on `@namzu/sdk` with Zod 4. What you may notice: the text of a tool-argument error the model reads is Zod 4's wording (for example `Invalid input: expected string, received undefined` where it said `Required`), and an argument an MCP server declares required but leaves untyped is now genuinely required, as the server said.
