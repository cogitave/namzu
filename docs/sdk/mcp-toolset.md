---
type: Reference
title: The MCP toolset
description: mcpToolset(client, options) — the one path from a connected MCP server to a live Toolset, its mcp__<server>__<rest> naming, its two deferred resource tools, and how it reacts to list_changed and a reconnect.
resource: packages/sdk/src/connector/mcp/mcp-toolset.ts
tags: [sdk, mcp, connector, toolsets]
status: stable
generated: { by: process:claude-code, at: 2026-09-24T00:00:00Z }
---

# The MCP toolset

`mcpToolset(client, options)` (`packages/sdk/src/connector/mcp/mcp-toolset.ts`) turns an already-connected `MCPClient` into a live [`Toolset`](toolsets.md): its tools, its prompts (through the existing adapters) and its resources, discovered, admitted and named together. It is the one path onto a `Toolset` from MCP — the CLI and a plugin are both meant to build a server's toolset this way, rather than calling `mcpToolToToolDefinition`/`mcpPromptToToolDefinition` directly.

```ts sketch
const client = new MCPClient({ serverName: 'github', transport: { type: 'stdio', command: 'gh-mcp' } })
await client.connect()
const toolset = await mcpToolset(client, {
  deny: ['delete_repo'],
  readOnlyHintTrusted: true,
  maxRetries: 2,
})
toolset.tools() // [{ name: 'mcp__github__create_issue', ... }, ...]
await toolset.close?.() // stops the reconnect supervisor this call started
```

## Naming

Every name this function produces is `mcp__<server>__<rest>`: a tool is `mcp__<server>__<tool>`, a prompt is `mcp__<server>__prompt__<name>` (prompts get their own segment so a server publishing a tool and a prompt under the same name cannot collide), and the two resource tools are `mcp__<server>__list_resources` and `mcp__<server>__read_resource`. This replaces the CLI's own historical `mcp_<server>_<tool>` (single underscore, ambiguous the moment either name contains one); the plugin path already used `mcp__`.

A name over the wire's 64-character ceiling is never refused: `mcpToolsetName(serverName, ...segments)` shortens it deterministically instead, truncating to 55 characters and appending an 8-hex-character hash of the full untruncated name (`_<hash>`), so two different overlong names that happen to share their first 55 characters still end up distinct, and the same inputs always shorten to the same output.

## Discovery, policy and drift

Tools and prompts go through `MCPToolDiscovery` — the same allow/deny policy and rug-pull drift detection `MCPToolDiscovery` has always done, keyed by the server's own name — before this function's naming and wrapping applies. `options.allow`/`options.deny` name the server's own tool/prompt names, before the `mcp__` prefix. `options.onDrift` is called when a re-discovery (a `list_changed` notification, or a reconnect) finds a tool set that differs from the last one: the changed, added or removed tool is reported, and also admitted into the next `tools()` snapshot — a toolset never holds a changed definition back on its own; that is a later item's job (`ToolManager`, a separate plan).

## Resources

When the server's `initialize`/discover capabilities include a `resources` key at all, this toolset adds two tools:

- `mcp__<server>__list_resources` — takes no arguments, calls `resources/list`, and returns the catalogue as JSON. Every call refreshes the admitted-URI set `read_resource` checks against.
- `mcp__<server>__read_resource` — takes `{ uri }`. The `uri` is refused unless it is one the server has listed — through `list_resources`, through the initial discovery this function runs at construction, or through a `resources/list_changed` refresh. Both the catalogue and a resource's content reach the model through the same framing (`frameServerResult`) an ordinary tool call's result does: server-authored text, marked as such.

These two tools are always wrapped `deferred(...)`, regardless of `options.availability` — a resource catalogue usually is not worth showing up front the way a server's tools are. `Toolset.availability` is a whole-toolset default, not a per-tool one, so this is built as an inner toolset (the resource pair) combined with the main one via `combineToolsets`, which also gives the combination its atomic same-source collision check for free (a tool, prompt or resource-tool name landing on the same `mcp__…` string as another throws `ToolsetConflictError`). **Known limitation:** `combineToolsets`'s own return has no single `.availability` — a combination is heterogeneous by nature — so when a server publishes resources, the toolset this function returns has no top-level `availability` of its own; a server with none returns the plain toolset directly, and `options.availability` applies to it as documented. This is revisited once a later item gives a per-tool availability override.

## Change and reconnection

`onChange` fires when a `tools/list_changed`, `prompts/list_changed` or `resources/list_changed` notification arrives from the server — gated on that capability's own `listChanged: true` having been advertised at connect time (or the last reconnect), so a server that never declared it cannot force a re-fetch merely by sending the notification anyway — and after every successful reconnection, since a restarted server is not a notification at all and may have come back with a different tool set entirely. `close()` stops the `MCPReconnectSupervisor` this function starts; pass `reconnect: { enabled: false }` for a caller that already runs its own supervisor against the same client, to avoid two supervisors racing to reconnect it.

## What stays internal

`mcpToolToToolDefinition` and `mcpPromptToToolDefinition` (`packages/sdk/src/connector/mcp/adapter.ts`, `prompt-adapter.ts`) build the pieces this function wraps and renames; they keep their own historical naming for every existing direct caller. They are staying exported from `@namzu/sdk` a little longer than planned, because `packages/cli`'s own `integrations/mcp/servers.ts` still calls `mcpToolToToolDefinition` directly — migrating that CLI path (its own naming convention, and its tests) is a separate item's job. Once nothing outside a toolset calls them directly, they stop being exported.
