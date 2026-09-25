---
'@namzu/cli': patch
'@namzu/sdk': patch
---

Former MCP permission-name warnings now use the CLI's structured logger instead of writing plain text to stderr. Consumers of `exec --json` stderr can continue parsing log records when a legacy permission rule is configured. Plugin MCP disconnect warnings use a fixed message and put the operation in a log attribute.
