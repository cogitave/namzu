---
"@namzu/sdk": minor
---

**The durable pause holds at its seams.** The pause survived a human; ten of its edges did not. A 32-agent review found them, each is now fixed and pinned by a regression test.

**The resume token is single-use for real.** It rested on a lock that was a `Map` on a store *instance*, while every decision entry point built its own store — so it serialised nothing. Two concurrent redemptions of one token both passed every check and both drove a resume, executing an approved (possibly destructive) batch twice; the loser could also die with an opaque `ENOENT` where the errors contract promises a `DecisionAlreadyResolvedError`, so a route could not tell a duplicate submit from a server fault. Single-use is now a property of the durable record: an exclusive-create claim the filesystem arbitrates, across stores and across processes. The same guard is taken again at dispatch, because handing exactly one caller a prepared resume does not stop that caller from being *run* twice.

**A pause taken after a partial gate denial is resumable.** The verification gate strips a denied call from the review request while leaving it in the assistant message, where it belongs. The resume demanded set-equality between the two, so any batch the gate had partially denied could never be resumed: the run hard-failed, the tool the human explicitly approved never ran, and the token was spent. The decision's calls are now a subset of the block's, and the denied call keeps the denial it already got.

**Cancel reaches the decision.** `cancelDecision` had no callers, so a cancelled paused run stayed `awaiting_input` with a live `pending` decision and anyone holding its token could still run its tools. `cancelRun` is the new seam — it closes every open decision and marks the run cancelled — and `AgentManager.cancel` (now async) uses it for a parked child, disposing the workspace and closing the sub-session that a cancelled child used to leak. `query()` refuses to resume a cancelled run at all.

**The suspension is persisted when it is decided**, not when the generator returns: a crash in between used to leave the run at `idle` holding an answerable decision that `resumeDecision` then refused forever. A resumed segment no longer stamps `idle` back over it.

Also: a `pause` at the plan gate ends the run instead of parking it on a decision nothing can answer; `DecisionLocator` takes a `parentRunId`, so a suspended child run can be found, answered and cancelled; resuming a parked `iteration_checkpoint` finishes the interrupted iteration's tail instead of skipping it; the pause no longer emits `tool_review_completed { rejected }` for a review that is still open, and then contradicts itself on resume; and a run that parks with a sandbox says so — a `Sandbox` cannot outlive its process, so the resumed batch runs in a fresh, empty one and the model is told rather than left to reason from a filesystem that no longer exists.

`AgentManagerContract.cancel` / `cancelAll` now return `Promise<void>` (a cancel has to reach the disk). `RunPersistence.markSuspended` is async. `PersistedRunMeta` gains `awaitingDecision`.
