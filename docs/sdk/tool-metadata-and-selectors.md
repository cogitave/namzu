---
type: Reference
title: Tool metadata and selectors
description: ToolDefinition.metadata as a host-only, never-on-the-wire data bag, matchesToolSelector's three selector shapes, and how an MCP server's annotations land in it.
resource: packages/sdk/src/tools/roster.ts
tags: [sdk, tools, mcp]
status: stable
generated: { by: process:claude-code, at: 2026-09-24T00:00:00Z }
---

# Tool metadata and selectors

`ToolDefinition.metadata?: Readonly<Record<string, unknown>>` is free-form, tool-author-declared data for filtering and behaviour customization — never a classification the runtime itself reads, and never a classification the model sees. `defineTool({ metadata })` sets it exactly as given.

# Never on the wire

Unlike `outputSchema`, which is shown in a tool's description precisely so the model can act on it, `metadata` is not sent at all. `ToolManager.toLLMTools()` builds a call's wire shape from `name`, `description` and `parameters` only; it does not read `metadata`. A host, a capability or a toolset wrapper can read it with `matchesToolSelector` or by hand.

# `matchesToolSelector`

```ts
import { matchesToolSelector, type ToolDefinition, type ToolSelector } from '@namzu/sdk'

function experimentalTools(tools: readonly ToolDefinition[]): readonly ToolDefinition[] {
  const selector: ToolSelector = { tag: 'experimental' }
  return tools.filter((tool) => matchesToolSelector(selector, tool))
}
```

A `ToolSelector` is one of three shapes, so a capability or a toolset wrapper can target a group of tools without maintaining a parallel name list of its own:

- **A list of exact tool names**: `['read', 'grep']`.
- **A partial, deep-equal match against `ToolDefinition.metadata`**: every key the selector names must be present on the tool's metadata with an equal value; a nested plain object recurses the same way, so `{ source: { team: 'search' } }` matches a tool whose metadata is `{ source: { team: 'search', tier: 2 } }`. A key the tool's metadata does not carry, or carries a different value for, fails the match. An empty object (`{}`) matches every tool; a tool with no `metadata` at all matches only the empty selector.
- **A predicate**: `(tool: ToolDefinition) => boolean`, for anything the two shapes above cannot express.

`matchesToolSelector` is synchronous only, unlike some other agent frameworks' equivalent selector (which also allow an async predicate): every place namzu filters a tool roster today does so synchronously, and an `Awaitable` branch nothing calls is a surface with nothing to test. It reads only `tool.name` and `tool.metadata`, never a tool's schema or its `execute`.

# What an MCP server's annotations become

`mcpToolToToolDefinition` (`packages/sdk/src/connector/mcp/adapter.ts`) turns a server's `readOnlyHint`/`destructiveHint` into `isReadOnly`/`isDestructive`. The authorization gate decides whether to trust the read-only claim from the owning toolset's `ToolSource.mcpServer.readOnlyHintTrusted`, never from tool metadata. The server's `title`, `idempotentHint`, `openWorldHint`, and any `_meta` on the entry land in `metadata` instead of being dropped:

```json
{
  "title": "Search the docs",
  "idempotentHint": true,
  "openWorldHint": false,
  "_meta": { "vendor.example/rateLimit": 5 }
}
```

The adapter also records the operator's `readOnlyHintTrusted` setting in `metadata` as advisory data, so the field is present even when the server sent no annotations or `_meta`. The gate reads the owning toolset's source instead. Server-authored metadata cannot grant or waive anything the gate acts on; see [The review policy](review-policy.md#a-call-the-tool-itself-declares-always-needs-approval) for the same trust boundary applied to `requiresApproval`, which `mcpToolToToolDefinition` deliberately never populates from a server's claims.
