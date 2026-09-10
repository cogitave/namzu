---
"@namzu/sdk": minor
---

Expose immutable request-context snapshots and occurrence-aware differences through `snapshotRequestContext`, `diffRequestContext` and `pre_llm_call.request.context`. Snapshots identify exact content blocks after SDK context reduction and request projection, including tool inputs separately from their results, without retaining raw content. Changes compare consecutive prepared requests within a run; hosts can compare snapshots across runs using the exported helper.

This is SDK-side context observability, not a guarantee about provider-private context, file freshness or complete file coverage. It does not suppress tool calls or add model instructions.
