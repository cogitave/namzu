---
"@namzu/cli": major
"@namzu/sdk": patch
---

**`@namzu/cli`**: the session's tool roster is now composed from named `Toolset`s (`@namzu/sdk`'s toolsets, plan.md v3 §8) instead of a `ToolRegistry`. This is internal composition, not a config or CLI-flag change — nothing in `namzu.config.json` or the command line changes — but it is a breaking change for anything that imported `@namzu/cli`'s internals directly:

| Removed / changed | Replace with |
| --- | --- |
| `createCliPluginRuntime(config, tools: ToolRegistry, cwd, hooks?, skillTool?)` | `createCliPluginRuntime(config, cwd, hooks?)` — it no longer takes or mutates a tool registry. Read `runtime.skills.size` and fold `runtime.manager.toolsets` into your own toolsets list; the `skill` tool is your own toolset now, not something this runtime registers. |
| `SubagentRuntimeOptions.buildTools: () => ToolRegistryContract` | `buildTools: () => readonly Toolset[]`. |
| `SubagentRuntimeOptions.configureWebSearch?: (provider, model, tools: ToolRegistryContract) => WebSearchConfig \| undefined` | `configureWebSearch?: (provider, model, toolsets: readonly Toolset[]) => WebSearchConfig \| undefined` — a pure decision now; it no longer removes `web_search` itself, so a caller building the child's final toolsets filters it out when this returns truthy (`filtered(ts, (t) => t.name !== 'web_search')`). |
| `McpConnection.tools: readonly ToolDefinition[]` (still present) | `McpConnection.toolsets: readonly Toolset[]`, one per connected server (kind `mcp_server`, id `mcp:<server>`) — prefer this; `.tools` is now just the flattened union across all of them. |

Additive: `AgentSession` gained a `presenter: ToolPresenter` field — the session's real tool-call/result presenter, for a host that renders events outside `send()`'s own stream. The ACP bridge (`namzu acp`) now uses it instead of a presenter built over a permanently empty registry, so tool-specific `presentCall`/`presentResult` views (a richer diff, a custom label) render over ACP for the first time; every ACP tool view had silently fallen back to the generic label before.

Behaviour: because tool availability is now derived from the turn's own revealed-tool history (`@namzu/sdk`'s `ToolManager`) rather than a per-send registry fork, a tool `search_tools` reveals in one send now stays active in a later send of the same session, and after `namzu resume` — it no longer resets every send.

**`@namzu/sdk`**: two `combineToolsets` usage bugs, found while wiring the CLI onto toolsets, are fixed — `query()`'s own generated tools and `SupervisorAgent`'s coordinator tools are now two separate array entries (an eager one and a deferred one) rather than one `combineToolsets`'d together, so `runtimeToolOverrides: { name: 'deferred' }` (task tools, coordinator tools) is honoured again instead of silently falling back to `'active'` for both halves. `query()` also no longer adds its own `search_tools` when a caller's `toolsets` already contribute a tool under that exact name (a connector genuinely named `search_tools`), matching the pre-toolsets registry's behaviour and avoiding a spurious `ToolsetConflictError`. Pure bug fixes, no API change.
