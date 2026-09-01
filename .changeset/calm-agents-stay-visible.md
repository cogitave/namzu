---
'@namzu/cli': major
'@namzu/sdk': minor
---

Show active delegated work automatically below the CLI composer, keep sibling
status and public interim answers visible while a batch runs, and provide
keyboard drill-down without sacrificing the current draft. Delegated Agent
calls now use the interactive one-hour deadline instead of the generic
two-minute tool limit. The CLI's ordinary and resumed interactive runs now use
that same one-hour upper deadline instead of the previous ten-minute default,
so callers that relied on the old automatic cutoff must enforce a ten-minute
process deadline themselves or cancel the turn explicitly.

Add `ToolContext.toolBatchId`, a stable optional identity shared by direct tool
calls issued in one model response, so hosts can group concurrent work without
mixing separate waves from the same run.
