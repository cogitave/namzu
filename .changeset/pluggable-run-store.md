---
"@namzu/sdk": minor
---

A run's own evidence can now be pointed somewhere other than the local disk.
`RunStore` is the contract behind the run record, its messages, its
transcript and its report; pass one as `query({ runStore })` or
`RunPersistence`'s `runStore` config, and `InMemoryRunStore` ships as a
working non-filesystem implementation.

Checkpoints already had this seam. The evidence did not — which for a kernel
whose stated purpose is auditable evidence meant the evidence was the one
part of a run that could not leave the box it ran on. On ephemeral
infrastructure the transcript died with the container; behind a load balancer
two replicas wrote two disjoint run trees for one tenant. The location was
injectable through a path builder, but that returns filesystem path strings,
so it relocated the directory without changing the medium.

**Nothing you have written breaks.** `runStore` is optional and defaults to
the same disk layout as before. `RunDiskStore` implements the new interface
and its signatures are unchanged.

Two things to know if you implement one:

- `initRun` and `writeReport` return `string | null`. `null` means "this run
  is not on a filesystem" — render it that way rather than treating it as an
  error, because `getRunDir()` feeds an operator-facing path and a
  synthesized one points at a directory that does not exist.
- `addToIndex` is **optional**. It maintains a browsable catalogue for a human
  reading a directory, so a backend without one declines it. The programmatic
  answer to "which runs are there" is `CheckpointStore.listDurableRuns`,
  which carries attribution and includes sub-runs.

`CompletedToolRecord` now lives on the contract and is re-exported from its
old location, so existing imports keep working.

**Not yet reachable: a run with zero filesystem writes.** `query()` still runs
the boot filesystem migration against a hardcoded `${cwd}/.namzu` before any
store is constructed, ignoring both the injected path builder and this
parameter. Making that conditional is the remaining half of this work and is
not in this release — so today a host can put its evidence anywhere, and the
process still touches the local disk once at startup.
