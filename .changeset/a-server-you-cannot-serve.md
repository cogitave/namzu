---
'@namzu/sdk': minor
---

`ServerStdioTransport` is now exported from the package root, along with the MCP tool-policy helpers `applyToolPolicy`, `applyNamePolicy`, `diffTools`, `hasDrift`, `toolsHash` and the types `MCPToolPolicy`, `MCPToolPolicyDecision`, `MCPToolDrift`, `MCPToolDiscoveryOptions`.

`MCPServer` was already public and `ServerStdioTransport` is the only transport in the package that can run one — so a consumer could construct an MCP server, register providers on it, and have no supported way to serve it. The policy types were public with no public function to apply them: a shape you could describe and not use.

The cause was two lists of the same thing. `connector/index.ts` hand-listed names from the individual `mcp/` modules while `connector/mcp/index.ts` kept its own set, and the two drifted. The connector barrel now sources every MCP name from that one seam, and a test fails if a leaf import is added back.
