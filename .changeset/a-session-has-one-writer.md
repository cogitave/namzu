---
'@namzu/sdk': minor
---

A session has one writer, and the store is what enforces it.

`Session.ownerVersion` is documented as the compare-and-set counter for handoff
and nothing enforced it. Both stores overwrote unconditionally, so the only
check lived in the handoff path — where it compared `source.ownerVersion`
against the assignment after `blockingRun`, `getProject` and `validateDepth` had
all awaited in between, which is a snapshot compared against itself. Worse, the
lock transition wrote `status: 'locked'` at the version it had read, so the
locked window was invisible: a second handoff holding the same snapshot saw an
unchanged version, passed the check, and locked the session again. Both
provisioned a worktree and one silently erased the other.

`ThreadStore` has had a working CAS since it was written. `SessionStore` now
does too.

**`updateSession(session, tenantId, expectedOwnerVersion?)`.** Supply it and the
store compares against the version it HAS STORED — not against the payload,
which is the caller's stale copy — and throws the new `StaleSessionError`
instead of writing. Omit it and behaviour is exactly what it was, which is the
compatibility promise.

The parameter is optional deliberately. Widening the interface is invisible to
callers and harmless to a host implementing its own store; a required parameter
would break every implementor for a guarantee they can opt into.

**The handoff lock now moves the version**, which is what makes it a lock, and
the commit keeps it rather than taking a second — so a handoff still consumes
exactly one version and `committedOwnerVersion` is unchanged. Only the
intermediate state changed, and that is the state that had to become visible.
Both the single and broadcast paths.

`StaleSessionError` is exported. A host that opts into the CAS has to tell
"somebody else took this session" from any other failure, and string-matching a
message is not a contract.

**In-process only, and stated rather than implied.** `DiskSessionStore` writes
atomically but its read-compare-write is not a critical section, so two
processes can still both pass. Closing that needs a lease with an expiry — not a
PID registry, because a Session is durable and written from hosts where a PID is
not a checkable fact. The contract says so where a caller will read it.
