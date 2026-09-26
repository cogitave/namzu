---
'@namzu/sdk': patch
---

Modern MCP subscriptions now stop retrying a server that permanently refuses `subscriptions/listen`, including HTTP 404 with JSON-RPC method-not-found. Temporary server errors and rate limits still retry with backoff. Operators get a warning and can reconnect after changing the server configuration.
An HTTP 200 JSON-RPC method-not-found refusal also stops retries, while a capacity refusal still retries. The response body is read with size and time bounds and released on completion, timeout or disconnect, preventing held responses from accumulating.
