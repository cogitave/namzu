---
'@namzu/sdk': patch
---

No runtime API changes. Idle-stream regression tests no longer abort a valid run when a busy CI runner takes longer than one second; their outcome now depends on the SDK's idle timeout and Vitest's test deadline.
