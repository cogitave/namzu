---
'@namzu/cli': patch
---

A large result from an MCP server is no longer cut with the rest lost. Over 30,000 characters, the model is shown the start and end of the text plus the path of a file holding all of it in the session's tool-results folder, and reads any part with `read` using `offset` and `limit`. The file is owner-only, written after the result screens, and goes when the session does. Results under the limit are unchanged.
