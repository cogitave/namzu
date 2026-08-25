---
'@namzu/sdk': major
'@namzu/cli': major
---

HTTP MCP transports no longer follow redirects. Configure the final MCP
endpoint directly instead of a URL that returns a 3xx response. This is a
breaking security boundary: authenticated SSE requests, session headers and
JSON-RPC bodies now remain at the exact configured endpoint. A redirected
tool call is reported as an unknown remote outcome that must not be retried
automatically, because the configured server may already have applied it.
