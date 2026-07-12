---
"@namzu/sdk": minor
---

**A run has an owner now, and resuming one is no longer the same act as forking it.**

**The run lease (G1).** Nothing said which process was driving a run. Two of them could resume one parked run at the same time: both ran `init()`, both wrote `run.json`, both wrote `messages.json`, the histories diverged and the last writer won — silently discarding the other's work, including tools it had already executed. A segment of execution now acquires the run's **lease** before it writes anything and holds it until it parks, finishes or dies; a second segment is refused with `RunLeaseHeldError` and writes nothing at all.

The lease **expires** — 30s by default, renewed on a heartbeat every TTL/3 — because a lease that could not expire would let the first crashed process take its run to the grave. Expiry is a guess, so it is made safe by a **fencing token**: a takeover mints a strictly higher token, and a stalled holder that wakes up late and tries to write is refused (`RunLeaseLostError`) instead of clobbering the run that moved on without it. Fencing stops a superseded segment from *writing*; it cannot stop one from having *run* — that is what the dispatch claim is for, and neither can un-charge a card.

`awaiting_input` now means exactly one thing. A **parked** run holds no lease and is safe to resume. A **live** segment holds it. A **crashed** segment leaves it *stale* — a distinct, observable third state, and an operator sees "held by a segment that has not renewed since T", not "waiting for a human". `readRunLease(locator)` is that read.

**Resume and fork are two doors (G2).** `query({ resumeFromCheckpoint })` refused only a `cancelled` run; a `completed` or `failed` one it re-drove happily under the same id, overwriting its record with the second drive's. **Resume** now continues *the* run — same id, same lifetime ledger, non-terminal only — and refuses a terminal one with `RunNotResumableError` naming the status it found. **Fork** starts a *new* run from a checkpoint: `prepareForkState` mints a new run id, carries the source's history, records provenance (`replayOf`, persisted on the fork's own `run.json`), and never touches the source's record. Forking *into* the source run is refused at both doors (`ForkTargetsSourceRunError`).

**And the refusal no longer destroys what it refuses.** Every guard in `query()` used to be raised *inside* its try, where `handleError` marks the run failed and `finalize()` persists that — so refusing to resume a cancelled run rewrote its `run.json` to `status: 'failed'` and its `messages.json` to `[]`. The run was destroyed by the guard protecting it. Admission (lease + resumability) now runs before the first write and throws out of `query()`.

New: `QueryParams.lease` (TTL / heartbeat / holder id) and `QueryParams.replayOf`; `PersistedRunMeta.replayOf`; `readRunLease`, `prepareForkState`, `RunLeaseHeldError`, `RunLeaseLostError`, `ForkTargetsSourceRunError`. `PrepareReplayInput` takes an optional `parentRunId`, so a child run's checkpoints can be forked. Runs now write a `leases/` directory alongside `checkpoints/`.
