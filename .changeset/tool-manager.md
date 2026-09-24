---
"@namzu/sdk": minor
---

Added `ToolManager` (`packages/sdk/src/toolsets/manager.ts`), the runtime-owned resolver of `Toolset`s that plan.md v3 §2 describes: `new ToolManager({ toolsets, resultGuardrails?, tierConfig?, messages })` resolves toolsets in order, then tools in order, throwing `ToolsetConflictError` on a name conflict at construction. `refresh()` adopts a live toolset's change only when called, reporting `added`/`removed`/`drifted`/`refused` names. `availability(name)` is derived — `'active'` or `'deferred'`, never stored — from the owning toolset's own declaration and whether a tool message in the turn's post-compaction history has revealed the name (`ToolMessage.revealedTools`, also added, the persisted form of `ToolResult.reveals`). `sourceOf(name)`, `toLLMTools`/`toPromptSection`/`toTierGuidance`/`searchDeferred(query, limit?)`, a narrow `view()` for `ToolContext`, and the `prepareExecution`/`executePrepared`/`execute` pipeline (copied from `ToolRegistry`'s, reading availability and source from the derivation instead of a stored map and `ToolDefinition.provenance`) round it out.

`ToolRegistry` is unaffected: nothing in the runtime constructs or reads a `ToolManager` yet. This is additive, exported as an advanced API ahead of `query()` and the rest of the runtime switching onto it in a later, separate change (which will also remove `ToolRegistry`).
