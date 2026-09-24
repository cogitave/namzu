---
"@namzu/sdk": patch
---

Fixed: `combineToolsets` dropped every input toolset's own `availability` (`'active'`/`'deferred'`) — the merged `Toolset` it returned had no `availability` field, which `ToolManager` and everything else that reads it defaults to `'active'`, regardless of whether some of the merged inputs were wrapped with `deferred(...)`. `query()` already avoided this by keeping its own eager and deferred halves as two separate array entries instead of combining them (see its own comment in `runtime/query/index.ts`), but `combineToolsets` itself stayed exported with this defect for any other caller.

`combineToolsets` now refuses to merge toolsets that disagree on availability, naming both sources, instead of silently reporting the deferred side's tools as active. Toolsets that agree — all active, or all deferred — combine as before, and the combined toolset now carries `availability: 'deferred'` when every input does. No current caller passes a mixed set (this was latent, not user-visible); a caller with a genuine eager/deferred split keeps them as two separate entries in its own `toolsets` array, the way `query()` does.
