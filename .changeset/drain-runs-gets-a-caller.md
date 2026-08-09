---
'@namzu/sdk': minor
'@namzu/cli': minor
---

`drainRuns` — the queue loop the cross-process claim shipped without

`claimRun`, `releaseRun`, the fenced `writeCheckpoint`, `listDurableRuns({ claimed: false })` and `resumeRun({ claimFence })` were all already here, and nothing outside the store's own tests called any of them. The two things the claim was built for — an approval inbox and a crash sweeper — still needed every host to write the same loop, including the two parts a host writes wrong: the release that belongs in a `finally` so a FAILED run goes back on the queue too, and the `null` claim that means "somebody got there first" rather than an error.

New: `drainRuns({ store, scope, holder, ttlMs, onRun, park?, signal?, maxConcurrent?, pageSize?, now? })`, plus the types `DrainRun`, `DrainRunsParams`, `DrainRunsResult`, `DrainFailure` and the constant `DEFAULT_DRAIN_PAGE_SIZE`. One bounded pass: list what nobody holds, claim it, hand it to your callback with its claim, release it. No timers, no processes, no `while (true)` — running it again is your scheduler's job.

**Read this before relying on "exactly once".** Two drainers never hold one run at the same time; that is absolute. Exactly-once over a pass is weaker and comes from the FILTER, not the claim: a listing is a snapshot, so between paging a row and claiming it another drainer can finish that run and release it. A claimed row is therefore re-read against `park` before any work starts, and one that no longer matches comes back as `stale`. An inbox drain (`park: ['outstanding']`) whose work answers the park is exactly-once. **With no park filter there is nothing to re-check and two drainers can both process one run** — a checkpoint store holds no run status by design, so "already done" is a fact only your own run records carry, and a crash sweep intersects with them inside `onRun`.

A store missing `listDurableRuns`, `claimRun` or `releaseRun` is refused with `capability_unavailable` **before anything is listed**, naming all three. It never degrades to "claimed by default", which would let every worker proceed on every run.

`@namzu/cli` gains `namzu drain --store <dir> --tenant <id> --project <id> --session <id>`, which claims each unheld run under that scope and continues it from its last checkpoint under that claim's fence. It is one pass and then exit: `namzu serve` still answers that namzu has no daemon, and this command is the shape that refusal implies — something your scheduler runs, not a service namzu owns. A run parked on a human decision is reported, never resumed past. Additive on both packages; nothing existing changes behaviour.
