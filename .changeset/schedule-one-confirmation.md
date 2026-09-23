---
'@namzu/sdk': patch
'@namzu/cli': patch
---

A job the model proposes, resumes or deletes in the TUI is confirmed once, on the job's own screen. The permission review no longer asks "Do you want to run schedule?" first in `prompt`, `accept-edits` or `auto`. `plan` and `strict` still refuse the call, a `schedule` rule of `ask` or `deny` still applies, and `pause` is still reviewed. The SDK's `schedule` tool no longer declares `delete` destructive, since the host confirms it before anything is removed; a host that relied on that flag to review deletes should add an `ask` rule for `schedule`.
