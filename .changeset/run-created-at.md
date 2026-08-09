---
"@namzu/sdk": minor
---

An approval inbox can now be triaged. `listDurableRuns` takes
`orderBy: 'createdAt'` and returns runs oldest first, so "which run has been
waiting longest" has an answer.

It could not before, and the reason was structural rather than an oversight.
A cursor has to sort on a key that cannot *move*, or a paging caller skips
rows and repeats them — and every timestamp a checkpoint store could derive
moves: the newest checkpoint's advances whenever the run checkpoints again,
the oldest one's advances whenever pruning deletes oldest-first. That left
`runId`, which is stable and carries no timestamp, so paging was safe and the
order was meaningless.

So there is now a key with both properties. `IterationCheckpoint.runCreatedAt`
records when the run was **attributed** — not when the checkpoint was written
— and is copied onto every checkpoint of the run. Pruning cannot reach a
value every survivor also holds, and a resume adopts the recorded one instead
of minting a fresh start, so the key never moves. It is `readonly`, settled
once per run and never reassigned.

- New: `DurableRunOrder` (`'runId' | 'createdAt'`),
  `ListDurableRunsOptions.orderBy`, `DurableRunEntry.runCreatedAt`,
  `IterationCheckpoint.runCreatedAt`.
- **The default order is unchanged** (`'runId'`), so a caller paging today
  keeps walking the same sequence. Pass `orderBy` to opt in.
- A cursor is a position in one order. Do not carry one across a change of
  `orderBy`. The listing now **refuses a cursor it did not issue** rather
  than treating an arbitrary string as a position — if you were constructing
  cursors from a `runId`, pass back the `cursor` from the previous page
  instead. The encoding is not part of the contract.

**Runs checkpointed before this release have no stamp.** Under
`orderBy: 'createdAt'` they come first, and `runCreatedAt` is absent on the
row so you can render "unknown" rather than a date nobody recorded. First is
not a guess: the stamp is written by the checkpoint manager, so a run without
one was checkpointed by a build that predates the stamp and therefore
predates every run that has one. Nothing needs migrating — a run that
checkpoints again after upgrading records its real attribution instant, which
is its original one.

An emergency dump's projection carries the stamp too, from the dump's own
`startedAt`. A crashed run is the one an operator is looking for, and it
would have been the one with no age.
