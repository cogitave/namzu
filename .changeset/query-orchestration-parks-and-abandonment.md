---
"@namzu/sdk": patch
---

Four defects in query orchestration, all `patch`. Two change observable
behaviour; two do not, and none of the four adds an export, removes one,
narrows a union or changes a default.

**A Stop now takes effect while a run is parked on plan approval.** The plan
gate awaited the host's `resumeHandler` directly, where the tool-review and
iteration-checkpoint parks race it against the run's abort signal, so a run
parked on plan approval ignored a Stop until the host answered — and the plan
gate runs in the iteration loop rather than inside a tool call, so nothing
bounded the wait. A Stop now resolves that park as an `abort` decision, which
settles the run as `cancelled` with `stopReason: 'cancelled'`, the same
resolution the other two parks have produced since the abort race was added to
them.

This is `patch` and not `minor` deliberately, so the reasoning is on the
record rather than implied: a host that was relying on the old behaviour was
relying on a hang, which is exactly the defect the abort race was introduced
to remove from the other two parks, and nothing about the parked state
changes shape — same `HITLDecisionRequest`, same `CheckpointId`, same
`HITLResumeDecision` union, and a `stopReason` that already existed. A parked
plan is still recorded durably before the await, so a host that wants to
approve a plan whose run was stopped can still find it and resume. A host
that needs the old "wait for the answer regardless" behaviour can park the
decision itself before calling `query()` and answer from its own queue.

**An abandoned run's record is terminal — unless a human is still being
asked.** A host that leaves the stream early — `for await (… ) break`, or
`gen.return()` — ran the run's teardown and stopped short of `finalize()`.
Since `finalize()` is the only caller of `RunPersistence.persist()`, the
durable record was whatever `init()` wrote, which is not a terminal state:
`deriveRunStatus` read it back as `queued`, work waiting to start, for a run
whose jobs were killed and whose sandbox was destroyed. Such a run is now
recorded `cancelled`. There is no new `RunExecutionStatus`, no new
`StopReason` and no new event — there is no consumer left to emit one to, and
the run did not fail, so `failed` would name an error that never happened.

A run whose consumer left while a park was OUTSTANDING is the exception, and
deliberately so: a park is a promise to a human, that run is resumable, and
`deriveRunStatus` reads a terminal status before it reads the park — so
writing `cancelled` there would have turned `awaiting_hitl` into `cancelled`
for a run somebody still owes an answer. The durable state decides, not the
in-memory state, because `handleHITLDecision` emits `run_paused` and drains it
BEFORE it sets its stop reason: a consumer that leaves on that event leaves a
run whose status is `running` and whose stop reason is unset at the instant
its park is already durable. Such a run is left exactly as it stands — no
verdict and no write, since the park row is its durable state — and a host
clears it by answering the park or by `expire`-ing an expired one.

What is durable here is the STATUS: measured against a real `RunDiskStore`,
`run.json` goes from `status: 'idle'` to `status: 'cancelled'` with an
`endedAt` for the mid-flight case, and stays non-terminal for the parked one.
`run.json` carries neither `stopReason` nor `result` for any run today, so the
`stopReason: 'cancelled'` that `markCancelled()` sets in memory is not written
there either: that is a separate defect, fixed separately, and nothing in this
change depends on it.

**A park answered by a resumed run is resolved, for the plan arm too.** The
resume path resolves the park its decision answers; the set of park/decision
pairs it covered named one park per condition, and the `plan_approval` arm was
missing — a run resumed with `{action: 'approve_plan'}` COMPLETED with its
park still outstanding, so a host was told a human still owed it an answer, a
second resume of the finished run was refused `awaiting-decision`, and with no
`hitlParkTtlMs` no `deadlineAt` existed either, leaving the row beyond
`expire` and beyond prune. Both plan verdicts now answer the park, through one
map from park type to answering decision so an arm cannot go missing by being
absent from a condition again. Resolving it does not depend on the resumed
process being able to act on it: nothing restores a plan on the resume path,
which is its own defect, and gating this on it would leave the row outstanding
for exactly the runs that need it cleared.

**Pruning no longer deletes a checkpoint a host is still waiting on.** With
`runConfig.pruneKeepLast` set, `CheckpointManager.prune` deleted the oldest
checkpoints by `createdAt` with no test for an unresolved park, while
`findPendingCheckpoint` and `listExpiredParks` in the same file treat one as
the thing a host is waiting on. A checkpoint carrying an unanswered question
is the row an approval queue serves, and collecting it deleted the question.
Prune still keeps the newest `keepLast` — the run's resume point is never at
risk — and now skips any candidate whose park is unresolved, so pruning
briefly holds a few more rows while a park is outstanding. A host that never
sets `pruneKeepLast` is unaffected entirely: that gate still means "never
prune". Expired parks are skipped too; the sweep for those is `expire`, which
resolves the park and keeps the record.

**The `executeBatch` docblock no longer claims a guarantee the throwing path
does not provide.** It said every `tool_use` is answered "by construction".
That holds for every path that returns — denials, approvals, a rejected
batch, a partial failure the fill-the-holes loop closes — and not for a call
that throws: `serial = serial.then(run)` means one rejection skips every
later serial call, so `Promise.all` rejects, the fill-the-holes loop never
runs, the batch produces no messages at all and the assistant turn keeps its
`tool_use` blocks unanswered for a resume to repair. The comment now says so.
No behaviour changed here; the guarantee was never provided on that path and
the run-level outcome is unchanged.

**One test that measured the machine instead of the code is de-flaked, with
no behaviour change at all.** `the-window-is-asked-once.test.ts`'s "falls
back and runs when metadata stays pending" drove a run with `timeoutMs: 20`
— which is simultaneously the run's budget and the context-window resolver's
private deadline — and then asserted that the run settled inside a 1000 ms
poll. The two 20 ms deadlines raced on a real clock: the run's own seam
checks could see the budget already spent by the very wait the deadline
exists to end, so the case failed in BOTH directions — no model request at
all, and a second one after the stream was cut — in three of five full-suite
runs, while passing every time on its own. It now runs under a fake clock
advanced exactly once, by exactly the deadline, and reads the resolver's
aborted signal before it waits on anything. The assertions are the same
ones, and none of them rests on a wall clock.

**Two more park defects, fixed on the same branch the same day, so this
changeset covers SIX fixes and all six are `patch` for the same reasons.**
The four above are the ones the branch opened with; these are the two the
tests that pinned them reported.

**An answered park is now resolved when the answer arrives across a
restart.** A run that paused at an iteration checkpoint, was resumed with
`{action: 'continue'}` and then COMPLETED kept the park outstanding on the
record forever: `planPendingResume` applies a decision only to a
`tool_review` or `user_question` park — an `iteration_checkpoint` park leaves
no unanswered tool call for a decision to reach — so the unpark never ran for
it. That was observable through two exports. `findPendingCheckpoint` (and
`CheckpointManager.findPending()`) kept returning a question nobody was
waiting on, and a second `resumeRun` of the finished run was refused with
`reason: 'awaiting-decision'` for a decision already taken. With
`runConfig.pruneKeepLast` set there was a third consequence, and it was the
worst one: `prune` skips an unresolved park, so the row could no longer be
collected by anything. Such a park is now resolved the way every other arm
resolves one — the record stays, the request stays on it, and only its
`pending` state ends. A `pause` is still not an answer: it holds the park, so
a resume that answers `pause` leaves it standing, exactly as the live path
does.

**A park whose batch crash recovery answered no longer records the human's
decision as its answer.** When the parked call's outcome could not be
established, recovery answered the batch with explicitly unknown outcomes and
the park was still written down as decided by whatever the human had said —
`{action: 'continue'}` on a park whose calls were never executed and never
approved. It is resolved either way, because leaving it outstanding would let
`findPendingCheckpoint` serve it as the newest park and a resume would then
rewind the run to the checkpoint the crash happened on. What changed is what
the record SAYS: it now carries `{action: 'pause'}` with a reason naming what
ended it, which is the shape `CheckpointManager.expire` already uses for "this
park ended and no decision was carried out" — `abort` was rejected there for
reading as somebody having refused it, and the same holds here. A consumer
that reads `pending.decision` as the audit of who approved what sees the
difference, so it is stated: a `pause` with a reason about crash recovery
means the answer you gave was recorded on the park but not applied by it. The
action the human took is still named in that reason. No export was added or
removed, no union widened or narrowed, no default changed.
