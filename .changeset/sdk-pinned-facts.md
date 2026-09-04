---
"@namzu/sdk": minor
---

A tool can pin a fact into the run's working memory. `ToolResult.workingState` is a list of `{ key, text }`; the executor pins each into the working state under the tool's name, a later pin under the same key replaces the earlier one, and pins render as `## Pinned by tools` in the working-memory slot — in front of the model every iteration, across compaction, and through checkpoints (`WorkingStateSnapshot.pins`, absent in older snapshots). An MCP server pins by returning a `resource` block of type `application/vnd.namzu.working-state+json` (`WORKING_STATE_MIME`) carrying a JSON array of pins. `WorkingStateManager.pin` / `unpin`, `MAX_PINS` (40) and `MAX_PIN_CHARS` (600) are exported; `WorkingState` gains `pins`, which a host that constructs the state by hand must add.
