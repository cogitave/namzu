---
"@namzu/sdk": major
---

Removed `ToolCatalog`, `createToolCatalogFromRegistry`, `loadingFromAvailability`, `toolDefinitionToCatalogEntry`, `ToolsetDefinition`, `ToolsetPolicy`, `ToolCatalogEntry`, `ToolCatalogSearchResult`, `ToolCatalogSnapshot` and `ToolLoadingMode`. This was a parallel, unwired model of sources/toolsets/tools with a per-tool policy: no query run ever called `toLLMTools`/`getToolsByLoading`/`searchTools` on it. This release also removes `ToolRegistry` and moves live discovery to `ToolManager` and `ToolResult.reveals`; see the `tool-registry-removed` changeset. `ToolSource` and `ToolSourceKind` stay.

If you constructed a `ToolCatalog` directly or called `createToolCatalogFromRegistry`, pass `toolsets` to the runtime and use `ToolManager`'s `listNames()` / `availability(name)` for an advanced host's roster view. Nothing else in the kernel ever populated the catalog from live state.
