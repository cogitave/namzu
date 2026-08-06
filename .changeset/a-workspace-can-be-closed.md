---
'@namzu/sdk': major
---

A closed workspace takes no new work.

Archiving a workspace meant nothing to the code. `Thread` carried a status and
`ThreadManager.requireOpen`; `Project` — the thing a tenant owns, configures,
gives an environment, and actually closes — carried neither, so the kernel kept
spawning agents into a workspace its owner had shut. This moves the archival
invariant to the level that survives the Thread removal.

**`Project` gains `status` and `ownerVersion`.** Breaking for anyone
implementing `SessionStore` themselves: a `Project` you construct now needs
both. Existing records on disk read as `open` at version `0`, which is what
they were — leaving `ownerVersion` undefined would be worse than a wrong
default, because every compare-and-set against it would fail and an existing
workspace could never be closed.

**New:** `ProjectManager` with `requireOpen`, `archive` and `reopen`;
`SessionStore.setProjectStatus` and `SessionStore.listSessionsByProject` (both
optional, so a host's own store keeps compiling); `ProjectClosedError`,
`ProjectNotEmptyError` and `StaleProjectError`, all three exported — a host
that closes a workspace has to tell "this workspace is closed" from any other
spawn failure, and matching on a message string is not a contract.

Three decisions worth naming.

**The gate is a function over a store, not an injected manager.** The three
ingress paths — spawn and both handoffs — already hold a `SessionStore`, so
`requireOpenProject(store, ...)` needed no constructor change anywhere. A gate
that requires new wiring is a gate somebody forgets to wire. In each path it
*replaces* the existing `getProject` + null check rather than adding a
round-trip, because a gate that costs something is a gate someone eventually
moves.

**Status moves both ways.** A thread was archived forever. A workspace is
long-lived and a mistaken close should not be permanent, so `reopen` exists.

**Archiving refuses rather than cascading.** A workspace with a session in
`active`, `locked`, `awaiting_merge` or `awaiting_hitl` throws
`ProjectNotEmptyError` naming what is blocking. A live session is a running
agent whose owner is still watching; closing its workspace out from under it
would strand work. Settle the sessions, then close. Re-archiving an already
closed, already empty workspace is a no-op that does not burn a version, so a
retry cannot lose a race it is not in.

Verified through the front door: the spawn case drives a real `AgentManager`,
so the assertion cannot pass with the gate call deleted — removing it fails two
tests. Calling the gate directly would only have proved the function throws.
