---
"@namzu/sdk": patch
---

Enforce the existing tool-mode structured-output retry allowance for unrepaired invalid JSON, truncated arguments and schema mismatches, as well as missing output. All such responses share one counter; multiple invalid calls in a response consume one correction after every sibling result is recorded. The default remains two correction opportunities. Valid paired candidates, ordinary tool work, successful local repairs, host refusals and reviewer rejections retain their separate behavior.

Persist corrections in optional `Checkpoint.review.toolStructuredAttempts`, saving feedback and answered results before another request. Exhausted resumes stop without another model call, and completed argument-failure evidence survives pending-batch recovery without revalidation. Old checkpoints and tool records remain readable without rewriting their bytes or hashes. Hosts must continue supplying the output configuration when resuming.
