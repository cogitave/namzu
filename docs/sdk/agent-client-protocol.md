---
type: Reference
title: Agent client protocol
description: Stdio prompt, permission, cancellation and durable-history boundaries for editor and desktop clients.
resource: packages/sdk/src/bridge/acp/server.ts
tags: [sdk, protocol, sessions, hosts]
---

# Agent client protocol

`ACPServer` adapts an `AcpAgentGateway` over an `MCPTransport`. Initialize with
`capabilities: ['permission']` before creating/loading a session. The peer must
answer `session/request_permission`; the bridge does not assume a missing human
approved a tool. `session/new`, `session/load`, `session/prompt` and
`session/cancel` preserve session ownership. Updates arrive as `session/update`.
Tool progress uses the existing `tool_call` update with optional `progress`
(`message` and an optional completion fraction). A client preserves the prior
presentation while updating progress. `turn_ended` may carry the actual `error`
message; a host should display that explanation instead of inventing a cause.

The gateway loads durable history, not a transport-owned transcript. Its
`load(sessionId, cwd?)` receives the requested absolute workspace as the second
argument. Existing one-argument gateways remain valid; hosts with scoped stores
should use that workspace to check project and tenant ownership. The CLI gateway
uses its existing resumable-conversation check and rejects archived writers.

## Explicit host extensions

`AcpServerOptions.extensions` optionally installs a table of handlers whose names
begin with `namzu/`. Names cannot replace core methods. The installed names are
advertised in `AcpInitializeResult.extensions`. Extension calls require initialized
permission negotiation; absent methods return method-not-found without closing
the connection. Handler arguments and return values must be JSON-compatible.

The bridge does not grant a generic shell or filesystem API through extensions.
A host owns each handler's validation and scope. `namzu acp --desktop` opts into the
CLI's [desktop operator methods](../cli/desktop.md). Ordinary `namzu acp` retains
its core method set and does not grant folder trust through protocol messages.

Stdout is reserved for JSON-RPC lines. Human logs go to stderr. Disconnect cancels
owned prompts and rejects pending permission requests.
