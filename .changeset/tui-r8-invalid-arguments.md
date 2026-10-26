---
'@namzu/sdk': minor
---

`ToolFailureReason` gains `invalid_arguments`: the call's arguments did not fit the tool's input schema, so the tool never ran. The tool registry now returns it in `facts` on that refusal (it has no `subject`). Nothing existing changes; if you `switch` over `ToolFailureReason` exhaustively, add a case for it or a default branch.
