---
'@namzu/sdk': minor
---

Seven places where state, consent or a verdict did not survive the boundary
it needed to cross.

**A checkpoint is versioned on disk, and its budgets are checked.** It was
written bare and read with a cast. Unstamped is read as version 1 by
definition, which is correct only while version 1 is the only version there
has ever been — the moment a second exists, a file written by the newer
build is read by the older one as if it were the older shape, and the
refusal that exists to prevent exactly that never fires. There was no chain
to hang a migration on. Separately, the read validated `id`, `iteration`,
`createdAt` and `messages` and skipped `tokenUsage` / `costInfo` /
`guardState` — which a resume dereferences before its first iteration. A
run recalled at $4.80 of a $5 cap whose cost came back malformed continued
with `NaN`, which compares false against every limit, so the guard that
exists to stop it never stopped it. Both read paths now refuse.

**A resumed run joins the trace it crashed inside.** `parentContext`
accepted only a live in-memory span, so a parent that had to survive a
process boundary could not be expressed. A run that crashed at iteration 12
and resumed produced two traces with different ids and no link. The run id
correlated them well enough to find both by query and not well enough to
see one waterfall — and for a replay fork, which mints a new run id, not
even that. Checkpoints now record a serialized span context, read back
*before* the root span is minted because a parent can only be set at
creation. An all-zero or malformed id is refused rather than emitted, since
an exporter drops those silently and that would be worse than the
disconnected traces it replaces.

**A park can expire.** `runConfig.hitlParkTtlMs` writes an ABSOLUTE
deadline. Every timer in the SDK is an in-process `setTimeout` and the
park-record delay is deliberately `unref`'d, so nothing in memory outlives
a redeploy: a run parked for approval, the worker was replaced, nobody
answered, and the checkpoint stayed outstanding forever with every
approval-queue reader serving it. The run timeout cannot cover it — it is
checked between iterations and a park suspends mid-iteration, so a
long-lived process hard-stops the run immediately *after* the human
approves, while across a restart the restored clock excludes parked time
entirely. `findPendingCheckpoint` skips an expired park, `listExpiredParks`
lets a host sweep, and `expire` records the expiry rather than deleting the
evidence.

**Two reserved statuses finally have producers.** `deriveRunStatus`
projects a run plus its park onto the session-layer `RunStatus`, which was
consumed by session derivation and handoff gating and produced by nothing —
`awaiting_hitl_resolution` in particular documented a "persisted wait after
a HITL timeout" for a timeout nothing could raise. `toWireRunStatus`
implements the domain→wire collapse that `WireRunStatus` had documented and
never had as code.

**An approval can be remembered, at a scope the approver chooses.**
Approving recorded nothing anywhere. `bash` is unconditionally
non-read-only and in no allowlist, so `bash: git status` re-prompted on
every batch forever, and the only escape was a blanket session grant
covering every destructive call. `approve_tools` now takes `remember`,
`toolGrantKeys(call)` offers a narrow (this exact invocation) and a wide
(this tool) key, and a batch fully covered by recorded grants skips the
park. Non-reuse stays the default — nothing is remembered unless an
explicit approval says so, and grants are run-scoped, never persisted.
Argument key order is normalised so the same call is not asked about twice.

**An eval case can fail on a gate, not just on an average.** The verdict
was one unweighted mean against one suite-wide threshold. At the default of
1 the harness never reports a false pass, but a trajectory F1 and a graded
judge can essentially never reach 1 — so every real suite lowers it, and
every step down buys the deterministic scorers the same tolerance as the
fuzzy ones. At 0.75, trajectory 0 alongside three perfect scores averages
to 0.75 and reports **passed**. `Scorer.severity: 'gate'` fails the case
outright; `threshold` is per-scorer. `completionScorer` and
`containsScorer` ship as gates. An unavailable gate does not fail a case —
it did not judge the run, which is the inconclusive path.

**A provider's own retryable flag is listened to, and a plugin that cannot
enable is refused at install.** Retryability was derived solely from
namzu's code set, a second-hand inference that necessarily lags every new
failure shape a vendor invents; a flag declared anywhere on the cause chain
now decides, while the code still decides what the failure *is*. And the
plugin manifest accepted `skills` / `connectors` / `personas` with per-type
caps that enabling then refused wholesale — so a plugin shipping four tools
and one skill validated clean, installed clean, was persisted as
`installed`, and contributed zero tools. The refusal moved to load time,
with the enable-time check kept as a backstop that transitions the plugin
to `error` rather than leaving a status that says it is fine.
