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
Completed tool updates retain the runtime-provided result presentation, including
bounded diff and terminal views. Older event producers without a presentation
keep the text-based presenter fallback. Clients do not infer changes from tool
arguments or names.

Tool progress uses the existing `tool_call` update with optional `progress`
(`message` and an optional completion fraction). A client preserves the prior
presentation while updating progress. `turn_ended` may carry the actual `error`
message; a host should display that explanation instead of inventing a cause.

The gateway loads durable history, not a transport-owned transcript. Its
`load(sessionId, cwd?)` receives the requested absolute workspace as the second
argument. Existing one-argument gateways remain valid; hosts with scoped stores
should use that workspace to check project and tenant ownership. The CLI gateway
uses its existing resumable-conversation check and rejects archived writers.

## Prompt attachments and options

`AcpSessionPromptParams.attachments` optionally carries inline user image or
document attachments. An embedded host opts in with
`AcpServerOptions.supportsPromptAttachments: true`; initialization then advertises
`AcpInitializeResult.promptAttachments: true`. The gateway's `prompt` receives
the validated attachments along with the authored text. Plain text requests are
unchanged. Clients must check the capability before sending attachment bytes.

This boundary accepts at most eight attachments and 3 MiB of decoded bytes per
message. Images use inline bytes; documents use inline text or PDF bytes.
Stored attachment references are refused because this transport does not own
the caller's attachment store. Unsupported attachment requests fail before the
gateway starts a turn. The CLI opts in and preserves attachments through its
actual user-message and history path.
The CLI refuses new image or document inputs before its send when its active
provider explicitly declares that media unsupported. Transport attachment
support alone does not establish model capability.

`AcpSessionPromptParams.options` optionally accepts `AcpPromptOptions` with
`effort?: ReasoningEffort` and `permissionMode?: ReviewMode`. The host opts in with
`supportsPromptOptions: true`, advertised as `promptOptions: true` at
initialization. Unknown fields, invalid modes and unsupported explicit options
are refused before execution. The CLI validates effort against the selected
session's actual provider menu, including its configured fallbacks, and applies
the captured review mode to that message's turn. These options do not rewrite
saved global preferences or change a currently running turn.

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
