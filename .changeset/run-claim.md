---
"@namzu/sdk": minor
---

Parked runs can now go on a queue with more than one reader.
`CheckpointStore.claimRun` takes exclusive working possession of a run;
`releaseRun` gives it back; `writeCheckpoint` takes an optional fence and
refuses a write from a worker that has been superseded.

Without this the only safe deployment was one writer per run, enforced
outside the SDK. Two workers would restore the same checkpoint, both execute
its tools, and both write under one run id — each write minting a fresh
checkpoint id, so two divergent chains land in one list and the pending
lookup returns whichever wrote last. Half the work vanishes and nothing
reports an error.

```ts
import { claimRun, listDurableRuns, releaseRun } from '@namzu/sdk'

const page = await listDurableRuns(store, { tenantId }, {
  park: ['outstanding'],
  claimed: false,          // only what nobody is working on
  orderBy: 'createdAt',    // oldest first
})

for (const entry of page.entries) {
  const claim = await claimRun(store, entry, { holder: 'worker-3', ttlMs: 60_000 })
  if (!claim) continue     // somebody else got there first — not an error
  try {
    // …resume the run, passing claim.fence on every durable write…
  } finally {
    await releaseRun(store, entry, claim.fence)
  }
}
```

**It is a lease, not a lock.** A lock held by a process that dies is held
forever and its runs need a human with a shell. Calling `claimRun` on a run
whose claim has expired succeeds and mints a higher fence; the dead holder is
not notified — it cannot be — it simply stops being able to write.

**That is what the fence is for.** A holder does not know it has expired: a
long pause, a suspended container and a partition all look from the inside
like time not passing, so it wakes and writes as though it still holds.
Liveness cannot be checked. What can be checked, at the write, is whether the
holding that write belongs to is still the current one — so `ClaimFence` is a
monotonically increasing number rather than a random token, because
randomness proves identity and cannot establish order.

**Nothing you have implemented breaks.** Both methods are optional on the
interface, so an existing custom `CheckpointStore` still satisfies it, and
`writeCheckpoint`'s new third parameter is optional. An unfenced write is
still accepted even on a claimed run — a host adopting claims on one worker
must not break the workers that have not adopted them yet.

Calling `claimRun` against a store that does not implement it raises
`capability_unavailable` rather than proceeding unclaimed. Skipping an absent
optional method is the natural thing to do here and the fatal one.

Also new: `claim` on `DurableRunEntry` and `claimed` on
`ListDurableRunsOptions`, so a queue reader can ask for the work nobody
holds. An **expired** claim counts as unheld — that is what expiry means, and
a reader that treated it as held would leave a dead worker's runs invisible
forever. New types: `RunClaim`, `ClaimFence`, `ClaimSummary`,
`ClaimRunOptions`. New helpers: `claimRun`, `releaseRun`, `toClaimSummary`,
`fencedOut`.

The built-in disk store implements this across processes with
`O_CREAT | O_EXCL`, so the kernel picks the winner rather than a
read-then-write. `InMemoryCheckpointStore` implements it too, and is
single-process by construction — use it for tests and single-writer hosts,
not for two workers.
