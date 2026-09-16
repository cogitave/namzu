---
"@namzu/sdk": major
---

`MCPClient.listTools()` can now return fewer tools than the server published. A tool whose `inputSchema` carries an invalid `x-mcp-header` annotation is excluded from the listing, with the tool name and the reason logged at `warn` (`namzu.mcp.tool`, `namzu.mcp.reason`). That is the breaking part: a tool a host used to receive, and a model used to be offered, can now be absent. Only tools carrying that annotation can be affected, and only on the Streamable HTTP transport — stdio and HTTP+SSE ignore the annotation entirely and exclude nothing.

**What the annotation is.** A server may ask that a tool parameter's value be mirrored into an `Mcp-Param-{name}` HTTP request header, so a load balancer or policy proxy can route and authorise a call without parsing JSON-RPC. A client on Streamable HTTP must support it, and must refuse a definition whose annotation breaks any of six constraints: non-empty; RFC 9110 `1*tchar` field-name syntax; no control characters, CR and LF in particular; case-insensitively unique across the whole `inputSchema`; applied only to a `string`, `boolean` or `integer` parameter, never a `number`; and statically reachable from the schema root through a chain of `properties` keys alone — never through `items`, `oneOf`/`anyOf`/`allOf`/`not`, `if`/`then`/`else` or `$ref`.

**What a call sends now.** On a modern (2026-07-28) Streamable HTTP connection, `callTool()` writes one `Mcp-Param-*` header per annotated parameter present in its arguments, read out of the same `params` object the request body carries. Values are written as the string, lowercase `true`/`false`, or a decimal integer, then wrapped in the `=?base64?…?=` sentinel when they cannot go into a field verbatim. The header is omitted — never sent empty — for an argument that is absent or `null`, for a value whose runtime type contradicts the schema, and for an integer outside ±(2^53−1). A legacy-era connection sends none of these, and neither does a call made before any `listTools()`.

**What a server can now make happen twice.** A `-32020` (`HeaderMismatch`) answer to a tool call triggers exactly one `tools/list` re-read and one retry of the same call, so a tool whose schema changed between the listing and the call recovers instead of failing. A second `-32020` surfaces to the caller. A tool call is therefore issued twice in that one case; a caller for whom a repeated call is unsafe should treat `-32020` as it would any other retried request.

**There is no opt out.** The exclusion is the spec's requirement, not a policy this client chooses, and a host that needs the previous behaviour — every published tool exposed regardless of its annotations — pins the previous major.

Additive alongside it: `validateMcpHeaderAnnotations`, which answers the same question about a schema a host holds, with the `McpHeaderAnnotationVerdict` and `McpParamHeaderBinding` types; and `McpEnvelopeInput.paramHeaders`, optional, so every existing `buildEnvelope` call is unchanged.

See [MCP protocol eras](../docs/sdk/mcp-protocol-eras.md#mirroring-tool-parameters-into-headers-x-mcp-header) for the constraints, the encoding table and the recovery.
