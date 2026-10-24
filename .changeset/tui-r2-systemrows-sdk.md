---
'@namzu/sdk': minor
---

Adds a `compaction_started` session event, emitted when an automatic compaction pass begins (fields: `iteration`, `reason` of `threshold` or `overflow`, `tokensBefore`, `contextWindowTokens`). A host can show a live "compacting" line instead of staying silent while the summary is written; it is always followed by `compaction_completed`, `compaction_failed` or `compaction_tool_results_cleared`. It is a new member of the `SessionEvent` union, so a consumer with an exhaustive `switch` over event types must add a case (or a default). The SSE bridge sends it as `compaction.started`; the A2A bridge does not forward it.
