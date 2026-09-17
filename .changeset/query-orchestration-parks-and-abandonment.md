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

**An abandoned run's record is terminal.** A host that leaves the stream
early — `for await (… ) break`, or `gen.return()` — ran the run's teardown
and stopped short of `finalize()`. Since `finalize()` is the only caller of
`RunPersistence.persist()`, the durable record was whatever `init()` wrote,
which is not a terminal state: `deriveRunStatus` read it back as `queued`,
work waiting to start, for a run whose jobs were killed and whose sandbox was
destroyed. Such a run is now recorded `cancelled`. There is no new
`RunExecutionStatus`, no new `StopReason` and no new event — there is no
consumer left to emit one to, and the run did not fail, so `failed` would
name an error that never happened.

What is durable here is the STATUS: measured against a real `RunDiskStore`,
`run.json` goes from `status: 'idle'` to `status: 'cancelled'` with an
`endedAt`. `run.json` carries neither `stopReason` nor `result` for any run
today, so the `stopReason: 'cancelled'` that `markCancelled()` sets in memory
is not written there either: that is a separate defect, fixed separately, and
nothing in this change depends on it.

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
