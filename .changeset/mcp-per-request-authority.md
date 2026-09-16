---
"@namzu/sdk": minor
---

Both MCP HTTP transports (`StreamableHttpTransport`, `HttpSseTransport`) now accept an optional `fetch?: MCPFetchLike` in their config, used in place of the ambient global `fetch` for every HTTP call the transport makes. `MCPFetchLike` (`{ok, status, headers, body, json(), text()}` via a real `Response`) is a new exported type — the same injectable, socket-free idea as `FetchLike` in the A2A bridge, re-declared here because both MCP transports read `.headers` and one reads a streamed `.body`.

`MCPRequestOptions` — already accepted by `listTools()`, `callTool()`, `readResource()`, `getPrompt()` and the rest — gains two more optional fields: `headers?: Record<string, string>`, merged over the transport's static config headers for that one request, and `bearerToken?: string`, sent as `Authorization: Bearer <token>` and applied after the merge so it overrides a configured `Authorization` header without touching a differently-named one such as a static `X-API-Key`. A per-request credential is refused at the same redirect boundary as a static one — `refuseMcpHttpRedirect` is untouched.

Everything here is additive and optional: a call that supplies none of the new fields sends the exact request it sent before this release. `HttpSseTransport`'s message POST is also fixed in passing to read `MCPTransportSendOptions.headers` at all — previously a per-send header (including the `MCP-Protocol-Version` header from the last release) silently never reached that transport's wire.

See [MCP protocol eras](../docs/sdk/mcp-protocol-eras.md#per-request-authority-injectable-fetch-bearer-token-headers) for the full model.
