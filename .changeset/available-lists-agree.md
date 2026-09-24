---
'@namzu/sdk': patch
---

The two errors that tell a model which tools it can use now give the same list: the tools the current step can call, meaning registered, active and allowed by `allowedTools` or `prepareStep`. Before, they could send a model back and forth between them until the run was stopped. A call refused as `Tool "X" is not available on this step` repeated the step's allow-list word for word. That list is taken when the request is built, so it could name a tool unregistered since (a connector that disconnected) or one that is deferred or suspended. A call to a name the registry does not hold listed the whole registry, including the tools the step refuses.

That second error now reads `Unknown tool "X". Available: …` instead of `Unknown or unavailable tool "X": Not found: "X". Available: …`. `(none)` means the step can call nothing. This applies to a model's direct call, to a batch run without review preparation, and to a call a tool makes through `ToolContext.dispatchTool` (such as `run_code`). `ToolCallRepairContext.message` for `unknown_tool` carries the new wording; `availableTools` still lists every registered tool. No exported types change. Code that parses the old `Not found` wording out of a tool result must look for the new wording instead.
