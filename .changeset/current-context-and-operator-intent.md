---
"@namzu/sdk": patch
---

Preserve new operator directions in compaction working state across inbound,
tool-attached and resumed-queue delivery. Runtime worker reports cannot replace
operator intent, and older surviving history cannot overwrite a newer checkpoint.

Invalidate stale provider prompt measurements when the working-memory block or
selected model changes. Resolve and cache provider context windows for selected
models, recheck compaction after model changes, and report context pressure against
the selected model. Preparation hooks are not replayed. Their existing position
after the initial compaction check is retained, so moving to a larger model can
still follow an earlier cleanup against the preceding window.
