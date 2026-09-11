---
'@namzu/sdk': patch
---

Wait for asynchronous plan approval listeners before resolving the approval,
so hosts can finish persisting the decision before disposing run storage.
