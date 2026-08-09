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
    await drainQuery({ ...params, claimFence: claim.fence })
  } finally {
    await releaseRun(store, entry, claim.fence)
  }
}
```

## What the fence covers, and what it does not

**The fence protects checkpoints. It does not yet protect the rest of a run's
durable state.** Read this before you rely on it.

`writeCheckpoint` is the only write that takes a fence today. When a run
settles it also writes its run record, its full message history, its report
and its index row, and all four go through a different store that has no
fence parameter. So two workers that both took the same run — because one
stalled past its lease and the other reclaimed it — are stopped from
corrupting the checkpoint chain, and **still overwrite each other's run
record, transcript and report.**

That is a real bound, not a theoretical one. It means a claim today buys you
a coherent resume point, not a coherent run.

Closing it needs the run store to become injectable and fence-aware, which is
separate work; until then, treat a claim as protecting the state a resume
reads and assume the settle-time artefacts are last-writer-wins. If that is
not good enough for your deployment, keep one writer per run.

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

The built-in disk store keeps one file per holding, named for its fence, and
takes a run by exclusively creating the next number — so the kernel picks the
winner in a single operation, the counter cannot rewind across a release, and
a body nobody can parse never hides the ordering.

**If you implement this yourself**, four properties the fence comparison
depends on and none of which the kernel can check: a fence must exceed every
fence ever issued for that run, including across a release; fences must be
unique, because the check is `<` and equality admits both holders; the check
must be atomic with the write; and `holder` must be unique per process, since
it is the only thing separating a renewal from a theft. They are on the
`claimRun` doc comment in full.

`InMemoryCheckpointStore` implements it too, and is single-process by
construction — use it for tests and single-writer hosts, not for two workers.
