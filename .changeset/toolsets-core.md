---
"@namzu/sdk": minor
---

New `packages/sdk/src/toolsets/` module: `Toolset` (the unit every tool comes from), `toolset(source, tools)`, the composable wrappers `prefixed`, `renamed`, `filtered`, `deferred`, `requireApproval`, `withMetadata` and `mapTools`, and `combineToolsets(source, toolsets)` with atomic name-conflict detection (`ToolsetConflictError`, extending the shared `RegistryCollisionError` — see [docs/sdk/registries.md](../docs/sdk/registries.md) — with `combineToolsets` as its registry name and the tool name as the colliding id; `name`, message and `firstSource`/`secondSource` are unchanged). Also `matchesSourceIdGlob` and `toToolSourceRef`. See [docs/sdk/toolsets.md](../docs/sdk/toolsets.md).

`filtered`'s `{ metadata }` selector and `requireApproval` compose with the `ToolDefinition.metadata` and `requiresApproval` fields (see the `tool-requires-approval-and-metadata` changeset). Existing callers must migrate from `ToolRegistry` to `Toolset` as described in the `tool-registry-removed` changeset.
