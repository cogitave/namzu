---
'@namzu/sdk': minor
---

A turn's outcome record no longer treats a call that did not run as one that may have changed files. A call the person declined, a rule refused, whose input was refused before it started or that the turn ended before it started, and a call that only launched work to go on after it returned, no longer make the verdict `unknown`; a host that printed "a command ran that may have changed files" for them now gets `unchanged` for a turn that did nothing else. A tool can say its call only launched work with the new optional `ToolResult.launched: true` (the sub-agent tools set it for a background launch, or a wait released before the child finished); a launched child's own changes stay its own record. A sub-agent waited for still counts as work that may have changed files. `ToolCallOutcome` gains `notRun` and `launched`.
