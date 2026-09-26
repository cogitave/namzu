---
type: Reference
title: The MCP toolset
description: mcpToolset(client, options) — the path from a connected MCP server to two live toolsets, its mcp__<server>__<rest> naming, deferred resource tools, and how it reacts to list_changed and a reconnect.
resource: packages/sdk/src/connector/mcp/mcp-toolset.ts
tags: [sdk, mcp, connector, toolsets]
status: stable
generated: { by: process:claude-code, at: 2026-09-24T00:00:00Z }
---

# The MCP toolset

`mcpToolset(client, options)` (`packages/sdk/src/connector/mcp/mcp-toolset.ts`) turns an already-connected `MCPClient` into two live [`Toolset`](toolsets.md) entries: one for its tools and prompts, one for its resources. Mount both entries in `ToolManager`. They are discovered, admitted and named together. The CLI and plugins use this path for MCP servers.

```ts sketch
const client = new MCPClient({ serverName: 'github', transport: { type: 'stdio', command: 'gh-mcp' } })
await client.connect()
const [main, resources] = await mcpToolset(client, {
  deny: ['delete_repo'],
  readOnlyHintTrusted: true,
  maxRetries: 2,
})
main.tools() // [{ name: 'mcp__github__create_issue', ... }, ...]
resources.availability // 'deferred'
const manager = new ToolManager({ toolsets: [main, resources], messages: () => [] })
await main.close?.() // stops the reconnect supervisor this call started
```

## Naming

Every name this function produces is `mcp__<server>__<rest>`: a tool is `mcp__<server>__<tool>`, a prompt is `mcp__<server>__prompt__<name>` (prompts get their own segment so a server publishing a tool and a prompt under the same name cannot collide), and the two resource tools are `mcp__<server>__list_resources` and `mcp__<server>__read_resource`. This replaces the CLI's own historical `mcp_<server>_<tool>` (single underscore, ambiguous the moment either name contains one); the plugin path already used `mcp__`.

A name over the wire's 64-character ceiling is never refused: `mcpToolsetName(serverName, ...segments)` shortens it deterministically instead, truncating to 55 characters and appending an 8-hex-character hash of the full untruncated name (`_<hash>`), so two different overlong names that happen to share their first 55 characters still end up distinct, and the same inputs always shorten to the same output.

## Discovery, policy and drift

Tools, prompts AND resources go through `MCPToolDiscovery` — the same allow/deny policy and rug-pull drift detection `MCPToolDiscovery` has always done for tools, keyed by the server's own name — before this function's naming and wrapping applies. A server that did not advertise prompt support is never asked for `prompts/list`; some older servers leave unknown methods unanswered. `options.allow`/`options.deny` name the server's own tool/prompt/resource names, before the `mcp__` prefix; a denied resource is never listed by `list_resources` and never admitted into `read_resource`'s URI set, the same as a denied tool never reaching `tools()`. `options.onRefused` reports the current refusals after every listing, including an empty list when refusals clear; each event names its server, `tools`/`prompts`/`resources` kind, item names and reasons. `options.onDrift` reports a changed, added or removed tool after re-discovery (`list_changed` or reconnect). Added and removed names reach the next snapshot. A changed tool's previously admitted definition remains in this toolset for its lifetime, including when a new `ToolManager` is built for a later turn; the callback reports that the new definition was held.

## Resources

When the server's `initialize`/discover capabilities include a `resources` key at all, this toolset adds two tools:

- `mcp__<server>__list_resources` — takes no arguments, calls `resources/list`, applies `options.allow`/`options.deny` to the result, and returns the admitted catalogue as JSON. Every call refreshes the admitted-URI set `read_resource` checks against.
- `mcp__<server>__read_resource` — takes `{ uri }`. The `uri` is refused unless it is one the server has listed AND policy admitted — through `list_resources`, through the initial discovery this function runs at construction, or through a `resources/list_changed` refresh. Both the catalogue and a resource's content reach the model through the same framing (`frameServerResult`) an ordinary tool call's result does: server-authored text, marked as such.

These two tools are always wrapped `deferred(...)`, regardless of `options.availability` — a resource catalogue usually is not worth showing up front the way a server's tools are. `Toolset.availability` is a whole-toolset default, so `mcpToolset` returns `[main, resources]` as separate entries. The main entry takes `options.availability`; the resource entry stays deferred, even after a reconnect. Mount the pair together. This function checks collisions across both entries at construction and after refresh; a tool, prompt or resource-tool name landing on the same `mcp__…` string throws `ToolsetConflictError`.

Whether the server supports resources AT ALL is re-checked on every reconnect, not decided once at construction: a server that gains the capability on a later connection (a restart with a newer build, say) gets the two tools added to the next `tools()` snapshot, and one that loses it has them removed.

## Tool call progress

An MCP tool call requests per-call `notifications/progress` only while its
executing host has a `ToolContext.report` callback. The adapter forwards
validated progress to that callback, including a fraction when the server
supplies a valid total; the CLI renders it through its normal live tool status.
See [Per-call tool progress](mcp-protocol-eras.md#per-call-tool-progress)
for token correlation, bounds and cancellation behavior.

## Change and reconnection

`onChange` fires when a `tools/list_changed`, `prompts/list_changed` or `resources/list_changed` notification arrives from the server — gated on that capability's own `listChanged: true` having been advertised at connect time (or the last reconnect), so a server that never declared it cannot force a re-fetch merely by sending the notification anyway — and after every successful reconnection, since a restarted server is not a notification at all and may have come back with a different tool set, and different capabilities (including whether it supports resources at all — see above), entirely. A refresh that a notification triggers is never left to reject unobserved: a failure is logged through `options.logger` rather than becoming an unhandled promise rejection. `close()` stops the `MCPReconnectSupervisor` this function starts and releases the `onNotification` subscription it registered. `options.reconnect` may be a fixed policy or a function read on every attempt, so a host can adjust retry limits while disconnected. Pass `reconnect: { enabled: false }` for a caller that already runs its own supervisor against the same client, to avoid two supervisors racing to reconnect it.

## What stays internal

`mcpToolToToolDefinition` and `mcpPromptToToolDefinition` (`packages/sdk/src/connector/mcp/adapter.ts`, `prompt-adapter.ts`) build the pieces this function wraps and renames. They remain exported for compatibility with direct SDK callers; the CLI and plugin lifecycle use `mcpToolset`.
