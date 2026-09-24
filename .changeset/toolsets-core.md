---
"@namzu/sdk": minor
---

New `packages/sdk/src/toolsets/` module: `Toolset` (the unit every tool comes from, ahead of `ToolRegistry`), `toolset(source, tools)`, the composable wrappers `prefixed`, `renamed`, `filtered`, `deferred`, `requireApproval`, `withMetadata` and `mapTools`, and `combineToolsets(source, toolsets)` with atomic name-conflict detection (`ToolsetConflictError`, extending the shared `RegistryCollisionError` — see [docs/sdk/registries.md](../docs/sdk/registries.md) — with `combineToolsets` as its registry name and the tool name as the colliding id; `name`, message and `firstSource`/`secondSource` are unchanged). Also `matchesSourceIdGlob` and `toToolSourceRef`. See [docs/sdk/toolsets.md](../docs/sdk/toolsets.md).

Purely additive: no existing export changed. `filtered`'s `{ metadata }` selector and `requireApproval` compose with the `ToolDefinition.metadata` and `requiresApproval` fields (see the `tool-requires-approval-and-metadata` changeset for those fields themselves and where they are enforced). Nothing to do to take this release.
