---
"@namzu/sdk": major
---

Removed `ToolCatalog`, `createToolCatalogFromRegistry`, `loadingFromAvailability`, `toolDefinitionToCatalogEntry`, `ToolsetDefinition`, `ToolsetPolicy`, `ToolCatalogEntry`, `ToolCatalogSearchResult`, `ToolCatalogSnapshot` and `ToolLoadingMode`. This was a parallel, unwired model of sources/toolsets/tools with a per-tool policy: no query run ever called `toLLMTools`/`getToolsByLoading`/`searchTools` on it. `ToolRegistry`'s own availability map (`getAvailability`/`activate`/`suspendAll`) and the `search_tools` scorer in `registry/tool/execute.ts` are the mechanism every run actually reads, and are unaffected. `ToolSource` and `ToolSourceKind` are unaffected and stay.

If you constructed a `ToolCatalog` directly or called `createToolCatalogFromRegistry`, read `ToolRegistry.getAll()` / `getAvailability(name)` instead — nothing else in the kernel ever populated the catalog from live state.
