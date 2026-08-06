---
'@namzu/sdk': patch
---

`ProjectManager.archive` refuses when it cannot establish the precondition.

14.0.0 shipped archival that "refuses rather than cascading" — a workspace with
a live session throws `ProjectNotEmptyError` instead of closing over running
work. The check read the session list as
`(await store.listSessionsByProject?.(...)) ?? []`, and `listSessionsByProject`
is optional. So on a store that does not implement it, "this store cannot tell
me what is running here" became "nothing is running here": the workspace closed
over live sessions and the call returned success.

It now throws, naming the missing method and what to do instead. Both stores in
this package implement it, so nothing in-tree changes; a host with its own
`SessionStore` gets a refusal where it previously got a wrong answer.

The mistake is worth naming, because the two halves are each correct and only
the combination is not. Optional-on-the-interface protects implementors: a
host's own store should not stop compiling because the SDK grew a method. It
cannot also mean a **safety precondition silently passes**. Where a store
cannot answer the question the check exists to ask, the answer is a refusal,
not a default.
