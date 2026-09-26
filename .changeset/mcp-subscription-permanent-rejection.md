---
'@namzu/sdk': patch
---

Modern MCP subscriptions now stop retrying a server that permanently refuses `subscriptions/listen`, including HTTP 404 with JSON-RPC method-not-found. Temporary server errors and rate limits still retry with backoff. Operators get a warning and can reconnect after changing the server configuration.
