---
"@namzu/sdk": minor
---

New `packages/sdk/src/toolsets/` module: `Toolset` (the unit every tool comes from, ahead of `ToolRegistry`), `toolset(source, tools)`, the composable wrappers `prefixed`, `renamed`, `filtered`, `deferred`, `requireApproval`, `withMetadata` and `mapTools`, and `combineToolsets(source, toolsets)` with atomic name-conflict detection (`ToolsetConflictError`). Also `matchesSourceIdGlob` and `toToolSourceRef`. See [docs/sdk/toolsets.md](../docs/sdk/toolsets.md).

Purely additive: no existing export changed. `ToolDefinition` gains two new optional fields nothing reads yet — `metadata` (never sent to the model; matched by `filtered`'s `{ metadata }` selector and set by `withMetadata`) and `requiresApproval` (set by `requireApproval`; a later release enforces it in `ToolRegistry`). Nothing to do to take this release; a consumer that inspects every key of a `ToolDefinition` object will see two new optional ones.
