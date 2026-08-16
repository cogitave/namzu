---
'@namzu/sdk': minor
---

New exported type `SubSessionDelegationStatus` — `'pending' | 'active' | 'idle' | 'failed' | 'archived'`, the five values the kernel actually writes to a sub-session. `SubSessionStatus` remains exported as a `@deprecated` alias of the wider eleven-member union; your code still compiles and warns. Removal, and the six extra members with it, is a later major.

A `SubSession` is the EDGE from a parent to a child. The child is an ordinary `Session` with its own `SessionStatus`, and the two unions shared `active`, `idle` and `archived` — plus `awaiting_merge`, which both declared. So "is this active" had two answers one import apart and nothing said which record to ask. `SubSession.status` now documents that it describes the delegation: whether the parent still has a live handoff, not whether the child is working.

Six of the eleven members had no writer anywhere in the workspace. Two of those (`merged`, `merge_rejected`) did have a reader: they sat in the archival manager's eligible set, matching values that could not occur. Those two stay archivable — `updateSubSession` takes a whole `SubSession`, so a host may have persisted one while the wide union permitted it, and dropping them would leave exactly those records permanently un-archivable.
