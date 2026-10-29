---
"@namzu/cli": patch
---

Prevent queued local peer context from waking or entering a receiving conversation after its permission mode changes. Incompatible pending mail is discarded with a local notice, even if an idle wake was already scheduled; switching back does not replay it. Different-mode sends remain refused, including in bypass mode, and peer messages never grant tool approval or change the receiver's permissions.
