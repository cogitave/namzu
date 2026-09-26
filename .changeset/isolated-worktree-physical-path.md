---
'@namzu/sdk': patch
---

Reject an explicitly isolated child workspace when a registered Git worktree
driver returns a missing path or a path that resolves to the caller's directory.
SDK hosts using a custom driver must return an existing, separate checkout.
