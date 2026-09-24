---
"@namzu/sdk": major
---

`ToolRegistry` is removed. The runtime now resolves tools from `Toolset`s
(plan.md v3 §2) through a `ToolManager` (`toolsets/manager.ts`, added in a
prior release) that `query()`/`drainQuery` builds for itself, once per turn,
from the `toolsets` you pass — it is never mutated by the runtime, and its
own generated tools (task tools, `search_tools`, the structured-output tool,
advisory tools) are combined in as a `runtime` toolset rather than injected
into your input.

**What breaks, and what to do about it:**

| Removed / changed | Replace with |
| --- | --- |
| `tools: ToolRegistryContract` on `QueryParams`, `ReactiveAgentConfig`, `RunAgentOptions`, `BidiTurnParams` | `toolsets: readonly Toolset[]`. Wrap a plain list with `toolset('name', [...])`; `deferred(toolset(...))` for a toolset whose tools start deferred. |
| `tools?: ToolRegistryContract` on `SupervisorAgentConfig` | `toolsets?: readonly Toolset[]` (same shape). |
| `ToolRegistry` class, `ToolRegistryContract`, `ToolRegistryRef`, `ToolRegistryForkOptions` | `ToolManager` (`new ToolManager({ toolsets, messages: () => turnMessages, resultGuardrails?, tierConfig? })`), exported as an advanced API. `ToolContext.toolRegistry` is now a `ToolsView` (`has`/`availability`/`searchDeferred` — no `activate`, no `searchActive`). |
| `registry.fork({ deferExcept })` | No replacement: build the `toolsets` array you want for that turn/send instead of forking a shared registry. There is no live shared registry to fork from any more. |
| `registry.activate(names)` / `.defer(names)` / `.suspendAll()` / `.hasSuspended()` / `.assignTiers()` | Gone. `.defer`/`.suspendAll`/`.hasSuspended`/`.assignTiers` had no production caller; `.activate()` did (`runtime/query/executor.ts`'s reveal handling, `tools/builtins/search-tools.ts`'s `search_tools`), and both are now the same derived mechanism. Availability is now DERIVED, never mutated: a tool is `'active'` unless its toolset declared `'deferred'` and no tool message in the turn's post-compaction history has revealed it (`ToolResult.reveals`, persisted as `ToolMessage.revealedTools`). A tool's own result reveals names for the rest of the turn; nothing calls `activate` any more, including `search_tools`. |
| `registry.searchActive(query)` | Gone. `ToolManager.searchDeferred(query, limit?)` remains, with an optional result cap. |
| `ToolDefinition.provenance` / `ToolProvenance` on a tool | `ToolManager.sourceOf(name)` — a lean `ToolSourceRef` (`id`, `kind`, and for `mcp_server`, `server` + `readOnlyHintTrusted`) that names the OWNING TOOLSET, not the tool. A definition can no longer claim its own source. `tools/trusted-read-only.ts`'s `isTrustedReadOnly` now takes that source as a third argument. `ToolProvenance` itself stays, as the shape `screenToolResult` reads. |
| `filterReadOnlyTools(registry)` / `filterToolsNamed(registry, names)` (`tools/roster.ts`) | `filtered(toolset, (tool, source) => isTrustedReadOnly(tool, undefined, source))` / `filtered(toolset, names)` (`toolsets/wrappers.ts`) — keeps the inner toolset's own `availability` and stays live over a live source, instead of freezing an always-`'active'` snapshot. `source` is the ONE toolset `filtered` runs on: filter each of a wider roster's contributing toolsets this way before combining them, never a toolset `combineToolsets` already merged from several sources (`tools/roster.ts` says why). |
| `ConnectorToolRouter` class (`registerTools`/`unregisterTools`/`refreshTools` mutating a registry) | `connectorTools(manager, { strategy? })` (`connector/tools/router.js`) — a plain function returning `ToolDefinition[]`; wrap it in `toolset(...)` yourself. Never had a production caller. |
| `mcp_<server>_<tool>` naming from the CLI's own MCP path | Unchanged in this release (the CLI does not yet build toolsets — that is a follow-up). `mcpToolToToolDefinition` no longer sets `.provenance`; a caller that wraps its tools into a toolset must set `source.kind: 'mcp_server'` with `mcpServer.name`/`readOnlyHintTrusted` itself (`plugin/lifecycle.ts` does this for plugin-contributed MCP servers). |
| `PluginLifecycleManagerConfig.toolRegistry` | Removed. `PluginLifecycleManager` now owns its own tool contributions and exposes them as `.toolsets: readonly Toolset[]` (two fixed, live toolsets — file-declared tools and MCP/prompt-adapted tools) for a host to fold into its own `toolsets` array. |
| `PluginResolver`'s second constructor argument | Was `ToolRegistryContract`; now `Pick<ToolManager, 'listNames' | 'has'>`. |
| `ToolRegistryConfig`, `ToolCatalog` and companions | Already gone in a prior release; `ToolManagerConfig` (`toolsets/manager.ts`) is the manager's construction config. |

**Not part of this change:** the CLI, `@namzu/live`'s duplex path callers,
and every other package that still passes `tools`/imports `ToolRegistry`
do not compile against this release — that migration is the next,
separate change. `@namzu/ag-ui`, `@namzu/computer-use`, `@namzu/files`,
`@namzu/lsp`, `@namzu/sandbox` are unaffected (no `ToolRegistry` reference).

A caller toolset that contributes a name `query()` also generates internally
(a task-tool name, `search_tools`, the structured-output tool's name, or an
enabled advisory tool's name) is refused at construction with
`ToolsetConflictError`, naming both sources — this generalises
`SupervisorAgent`'s old hand-written refusal of a caller tool shadowing one
of its six coordinator names, which is now the same mechanism (its
coordinator tools are just another toolset).

`search_tools` no longer activates anything: it returns `reveals` on its own
result, like any other tool now can. Its receipt for "no deferred match"
no longer echoes already-active matching tools, since the tool-body-facing
`ToolsView` has no active-tool search — only `searchDeferred`.

**Security-relevant, additive:** `ToolCallContext` (`authorization/gate.ts`)
gains an optional `toolSource?: ToolSourceRef`, and `AuthorizationGate`'s
`allow_read_only` rule now reads it the same way `isTrustedReadOnly` always
has. Without `ToolDefinition.provenance` travelling with the tool object,
the live gate had no way to tell an operator-trusted MCP server's own
`readOnlyHint: true` from an untrusted one's — both call sites in
`runtime/query/iteration/phases/tool-review.ts` and the two in
`runtime/query/executor.ts` (nested tool calls) now pass
`ToolManager.sourceOf(name)`. A host that builds its own `AuthorizationGate`
calls and does not thread `toolSource` through gets the same "no untrusted
party known" default as before (host-defined tools were never affected),
but should pass it wherever it has a `ToolManager` to ask. Separately,
`ToolPredicate` (`toolsets/types.ts`) widens to
`(tool, source: ToolSourceRef) => boolean`; `filtered`/`requireApproval` now
supply the toolset's own source as the second argument, existing single-arg
predicates are unaffected. See the `filterReadOnlyTools` row above for the
one-source-at-a-time rule this predicate needs to stay correct across a
combined, multi-source roster.
