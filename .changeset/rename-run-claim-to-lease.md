---
'@namzu/sdk': minor
---

The run-claim types now use the settled distributed-locking vocabulary. Old
names still work and are marked `@deprecated`; they go in the next major.

| Old | New |
| --- | --- |
| `RunClaim` | `RunLease` |
| `ClaimFence` | `FencingToken` |
| `ClaimSummary` | `LeaseSummary` |

What these describe is textbook: a time-bounded exclusive grant on a run
(holder, fence, absolute `expiresAt`), plus a monotonically increasing
number a store compares to reject a superseded writer. That is a lease and
a fencing token — terms with a literature a reader can go and check.
"Claim" and "Fence" read as ad hoc ownership flags, so nothing told a reader
to expect the guarantees the mechanism actually provides, and the
`fence?: ClaimFence` threaded through `saveCheckpoint` and `releaseRun`
looked decorative rather than load-bearing.

The verbs are deliberately unchanged. `claimRun`, `releaseRun` and
`toClaimSummary` keep their names — "claim a lease" is idiomatic, and
renaming the methods would break every `CheckpointStore` implementor for no
reading gain.

`FencingToken` remains a bare `number` alias. It buys clarity, not type
safety; making the ids nominal is a separate change.

To migrate, change the type import. No runtime behaviour moves.
