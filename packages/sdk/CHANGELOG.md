# Changelog

## 22.0.0

### Major Changes

- a4bcbc9: Runs report what they cost, and a cost limit that cannot be measured is refused

  Every run reported `$0.00`. `calculateCost` existed and `CostInfo` was carried on
  the run, the step, the checkpoint and the `token_usage_updated` event — but a
  turn was only priced when the host passed `pricing` to `query()`, and no shipped
  surface passed one. The accumulation branch was dead everywhere.

  `runConfig.costLimitUsd` is enforced against that same total, so a host that set
  a cost cap did not have one, and nothing said so.

  **`@namzu/sdk` now ships a price catalogue** — `packages/sdk/src/pricing/`, a
  module generated from a reviewed in-tree source table and checked in, so a cost
  number is reproducible from a commit and an offline run still prices correctly.
  Rates are looked up per turn against the driver and model that actually served
  it. No configuration is needed to get a real number.

  ## What every caller sees change

  **A run that reported zero now reports a real number.** If you compare, store,
  bill from, or assert on `Run.costInfo.totalCost`, the value moves on the same
  inputs. Nothing about your code has to change for this — but nothing warns you
  either, so check anywhere a zero was being relied upon.

  **A `costLimitUsd` that was inert now enforces, or refuses.** This is the change
  most likely to break a working deployment, and it can do so at two moments:

  - `query()` throws `invalid_config` at the start of a run when `costLimitUsd` is
    set, no `pricing` is supplied, and the configured model has no rate. Same
    config, same model, previously-completing run — now a startup failure.
  - A run stops with the new `cost_unmeasurable` stop reason when a step or a
    provider-chain member swaps to a model with no rate mid-run.

  To keep a run working, do one of: pass `pricing` to declare the rate yourself;
  add the model to `packages/sdk/src/pricing/rates.source.json` and regenerate;
  or drop `costLimitUsd` and bound the run with `tokenBudget`, which is always
  measurable. Removing the limit is the honest option if the model cannot be
  priced — a budget you cannot measure was never enforcing anything.

  ## Breaking API changes

  - **`CostInfo.inputCostPer1M` and `CostInfo.outputCostPer1M` are now optional.**
    Absent means no single rate card describes the total — the run spanned two
    models, or part of it ran at no known rate. Readers that treated these as
    `number` need a `?? ` or a branch. They were previously required and reported
    whichever card was applied last, which was a claim about the whole total that
    was true of only part of it.
  - **`CostInfo` gains a required `unpricedTokens: number`.** Any code that
    constructs a `CostInfo` must supply it. Zero means nothing is unaccounted for.
    This is what lets a consumer tell "this run cost nothing" from "nobody knows
    what this run cost" — previously both were `totalCost: 0`.
  - **`calculateCost` and `accumulateCost` lost their trailing `cacheDiscount`
    parameter.** It defaulted to `0`, no caller in the tree ever passed it, and
    the value it produced was subtracted from the total. `cacheDiscount` is now
    computed from the rate card and _reported_ rather than subtracted — it is what
    the cache reads saved against the full input rate, and the saving is already
    inside `totalCost`. Callers passing a fourth argument get a compile error;
    drop it.
  - **`StopReason` gains `cost_unmeasurable`.** Exhaustive switches over
    `StopReason` will not compile until they handle it.
  - **`RunPersistence.accumulateUsage` and `recordTurnUsage` take a second
    required argument** naming who served the tokens. Required so a call site
    cannot silently misattribute; pass `{ providerId, model }`.
  - **`projectEmergencyToCheckpoint` no longer reports zero cost.** A dump
    preserves a real `tokenUsage` and records no cost, so the projection now
    states that those tokens are unpriced rather than that they were free.

  ## Also fixed

  - The advisory executor reported `totalCost: 0` for an advisor with no pricing
    table — zero-as-unknown, the same defect one file over. It now reports the
    tokens as unpriced, and falls back to the catalogue before giving up.
  - Cache tokens are priced. The drivers in this repository disagree about whether
    the prompt-token count already contains cache reads (two exclude them, one
    includes them), so that fact is declared per driver in the rate source and the
    arithmetic reads it. Previously cache reads were charged at the full input
    rate or not at all, depending on the driver, and `cacheDiscount` was dead.

  ## `@namzu/anthropic`

  The driver's offline model menu moves to an exported `OFFLINE_MODEL_CATALOGUE`
  so a test can read it without a client. Two of the three models it offers had no
  rate in the catalogue — a lookup-key mismatch that reads as "cost unknown" and
  that the generator's own regeneration check is structurally blind to. Both rates
  are added and a conformance test now holds the two lists together. No behaviour
  change for callers.

## 21.1.0

### Minor Changes

- f59a8b0: `--gate '<command>'` — a run that is not allowed to finish on a red build

  `reviewAnswer` shipped complete: consulted only when the model stops calling tools, never on the forced-final turn, bounded by a rejection budget, with its own terminal state `answer_rejected` so a stop is not mistaken for a token budget running out. **No shipped app supplied one**, so an operator could not use any of it without writing TypeScript.

  New in `@namzu/sdk`: `createCommandGate({ commands, cwd, maxRetries?, timeoutMs?, exec?, maxOutputChars?, fingerprint? }): ReviewAnswer`. It runs shell command lines in order, stops at the first failure, and hands the failure back as the next user turn naming the command, the attempt, the exit code and a head-and-tail clip of the output.

  New in `@namzu/cli`: a repeatable `--gate '<command>'` on `run` and `run-stream`, plus `--gate-retries <n>`. Repeating the flag appends rather than replaces — `--gate 'pnpm typecheck' --gate 'pnpm test'` means both, in that order.

  **The part that makes it a bounded loop rather than one that burns its budget.** Before re-running a command that already failed, the workspace is fingerprinted; if it is byte-for-byte identical to the snapshot taken when that command last failed, the command is **not run**. The attempt still advances and the model is told the workspace has not changed and must edit something before trying to finish — cheaper than a full test run, and a _different_ instruction from repeating a failure it has already been shown.

  Also new and exported: `fingerprintWorkspace({ cwd, exec, timeoutMs?, maxBytes?, fs? })`. It hashes `git status --porcelain`, `git diff --binary HEAD` and the contents of every untracked file, **recording a symlink as its target rather than reading through it** — a link repointed to a different file with identical bytes is a change, and following it would hash the two the same.

  It returns `null` — meaning _no fingerprint_ — for a non-zero git exit, a tree with no commits, a timeout, or output past the size cap, and a caller that cannot fingerprint re-runs its command. That direction is deliberate: a wrong `null` costs one execution, while a wrong match is a verification that silently did not happen.

  A run with no `--gate` is byte-identical to one from before this existed: the option is spread in only when gates were asked for.

- 1be00a7: A run now remembers what it worked out, instead of dropping it at settle

  `promoteMemory` is invoked once when a run settles, with the compaction extractor's already-structured output — decisions, discoveries, user requirements, failures, environment facts, with eviction counts carried rather than hidden. **No shipped app supplied the hook.** So that structure, which the compaction pass spent tokens producing, was serialized into one system message and dropped on the floor when the run ended; the only way into namzu's memory store was the model deciding to call `save_memory`.

  New in `@namzu/sdk`: `createMemoryPromoter({ store, tags?, maxPerCategory? }): PromoteMemory`, plus `RUN_MEMORY_TAG`. `@namzu/cli` supplies it over the very store its memory tools already use, so what a run learns is what `search_memory` finds on the next one.

  ## What changes for you without asking

  **This is on by default, and it applies to the interactive TUI as well as to `namzu run` and `namzu run-stream`.** The promoter is supplied from the session every surface is built on, so an ordinary chat session that works something out now leaves a markdown record under `<cwd>/.namzu/memory` when the run settles — a directory that previously only ever grew when the model chose to call `save_memory`. The next session's `search_memory` will find those records, which is the point, and it is also the part you will notice.

  It is not opt-in because the alternative it replaces is not neutral: a run's extracted knowledge was being discarded at settle, and a flag would mean the default stays the lossy one. What keeps it from being noisy is the filter below — a session that answered a question without deciding, discovering, failing at or being told anything durable writes nothing at all.

  An SDK embedder can replace or disable it by passing its own `promoteMemory` to `query` — a function that does nothing writes nothing. **The CLI has no flag for it in this release**, which is worth knowing before you upgrade if a written-to `.namzu/memory` is a problem for your setup; say so and it becomes one.

  **The filter is the whole decision, and it is strict.** A run that learned nothing leaves **no record at all** — not an empty one, not one whose body says "no decisions". Only the five knowledge categories count: user requirements, decisions, discoveries, failures, environment. Not `task`, which every run has because it is the prompt restated; not `files`, which every run that opened anything has and which says what was _touched_ rather than what was _learned_. The model reads this store on later runs, so a record per run is not merely wasted disk — it is context spent on runs that discovered nothing.

  Records are markdown, tagged `run-memory`, and carry the forming run's id in their metadata so a surprising memory can be checked against what actually happened. Eviction counts are rendered, because somebody reading the record should know they are reading a truncated account of the run.

  The promoter deliberately does **not** catch its own failures: the runtime already catches and logs a promoter throw at settle without touching the answer, and catching here as well would hide a broken store from the one place that reports it.

  It also does not deduplicate, merge with a previous run's record, or expire anything. Each is a policy with real trade-offs, and `promoteMemory` is a callback precisely so the runtime does not decide them — this is the obvious default, not the only possible one. Pass your own `PromoteMemory` to `query` to replace it.

  Sub-agents do not promote. A parent that delegated six times would otherwise leave seven accounts of one piece of work for the next run to read; the parent's settle speaks for the whole task.

## 21.0.0

### Major Changes

- 8975cce: `namzu doctor` no longer exits 0 when a check could not answer

  **What breaks.** `namzu doctor` gains a new exit code, `69`, and a new status
  word, `skipped`.

  - **A CI step running `namzu doctor` can now fail where it used to pass.** If a
    check times out, is aborted, or the thing it reads throws, the command exits
    `69` instead of `0`. Nothing is claimed to have failed — `1` still means that
    — but the report is incomplete, and it used to say so only in text nothing
    reads. If you need the old behaviour while you look into it, treat `69` as
    success explicitly rather than by accident.
  - **`DoctorStatus` gains `'skipped'`.** An exhaustive `switch` over it, or a
    `Record<DoctorStatus, …>`, stops compiling. Handle `skipped` as "there was
    nothing here to check" — an ordinary state of a healthy machine, not a
    problem.
  - **`DoctorReport['exit']` gains `69`**, and `DoctorReport['summary']` gains a
    required `skipped: number`. Code that constructs a `DoctorReport` by hand must
    add the field; code that reads the summary can now rely on the counts summing
    to `total`, which they did not while `skipped` was hidden inside
    `inconclusive`.

  **Why.** "Healthy" and "did not manage to look" shared an exit code in the one
  command whose entire job is to report state it read. Fixing that needed the
  status vocabulary split first, because `inconclusive` was carrying two facts:
  _there is nothing here to check_ — an optional package absent, a registry with
  no auto-discovery, nothing configured yet — and _this check did not answer_.
  Only the second is a gap worth an exit code; making both non-zero would have
  turned `namzu doctor` red on every healthy machine.

  So `vault.registered`, `providers.registered`, `providers.chain` with no
  preferences file, and `telemetry.installed` with the package absent now report
  `skipped`, and they still exit `0`.

  **Also fixed:** `telemetry.installed` reported `not installed (optional
package)` for _any_ import failure, so a package that was present and threw on
  load was reported as absent. Resolution and loading are now asked separately —
  cannot resolve is `skipped`, resolves but throws is `fail`, with the reason.

  **Why 69 and not 2.** `2` already means "no checks registered" here. `namzu
eval` spells the same idea `2`, which it can because it never spent that number
  on anything else; giving one number two meanings inside one command is worse
  than giving one meaning two numbers across two. `69` is sysexits
  `EX_UNAVAILABLE`.

- 1582bdb: Run events carry a sequence, and the log can be read back

  A consumer that loses its connection mid-run can now reconnect at a cursor and
  receive every non-ephemeral event it missed — exactly once, in order, across a
  process restart. Before this the event envelope carried no position at all, the
  durable store had no read-back over the log, and a returning consumer had to
  re-derive the whole run from scratch.

  **Breaking, and it is one line if you implement `RunStore` yourself:** the
  contract gains a required `readEvents(options?)`. Add it and you are done; both
  shipped stores implement it. It is required rather than optional because a store
  that records a transcript it cannot read back is write-only evidence, which is
  the defect this contract exists to fix one level up — and optional would push a
  capability hole into anything built on top of it.

  **Nothing else breaks.** `seq` and `generation` are optional on the envelope, so
  code that constructs `RunEvent` values still compiles. `RunEvent`'s
  `schemaVersion` is deliberately NOT bumped: the version is for breaking envelope
  changes, and a v4 stamp would imply `seq` is present when its absence is
  meaningful.

  What you get:

  - **`seq` means the event is in the durable log.** The emitter takes a number,
    appends the event stamped with it, and only a write that landed advances the
    counter and reaches the live stream — so a cursor never points past the
    evidence. Its absence is equally load-bearing: the high-frequency events that
    are never persisted, an event whose durable write failed, and the delegation
    lifecycle events the agent manager hands straight to your listener without
    passing through the run's log. Never advance a cursor onto an event with no
    `seq`.
  - **`RunStore.readEvents({ sinceSeq })`**, exclusive on the cursor, oldest
    first. Plus `readRunEventsIn(runDir)` for reading a run this process never
    started — binding a `RunDiskStore` to read would create the run's directory.
  - **`QueryParams.eventCursor` and `onEventReplay`**, and on `resumeRun` a
    `listener` plus the verdict on its outcome. `resumeRun` previously drained the
    run and discarded every event it produced, so the one API for continuing a run
    another process started could not show anybody what the run was doing.
  - **A typed verdict rather than a best effort.** `complete`, `replayed`, or
    `unavailable` with `cursor_ahead`, `generation_changed` or `gap`. On any
    refusal the run still resumes and nothing from the log is delivered, because a
    consumer that receives a short catch-up folds a hole into its state and cannot
    tell. `resolveRunEventReplay` is exported and pure.
  - **`generation` is the claim fence**, so a takeover is ordered rather than
    merely detectable. Absent on an unfenced run.
  - **`MappedStreamEvent.id`** — `"<runId>:<seq>"`, keyed on the event's own run
    because a parent's stream carries its children's events and each run numbers
    its own log.

  Three defects fixed on the way, each of which falsified the property:

  - `resumeRun` dropped `parentRunId`, so a resumed **sub-run** bound
    `<base>/<runId>` instead of `<base>/<parent>/children/<runId>` — a second,
    empty transcript under a run id that already had one.
  - `InMemoryRunStore.initRun` rebound to a new run id without clearing, so one
    instance reused for a fork reported the previous run's evidence as this one's.
  - A `transcript.jsonl` cut off mid-write merged its fragment with the **next**
    whole event into one unparsable line, losing an event the emitter had counted
    as durable. `initRun` now terminates a torn tail.

  Not in scope, and stated because implying otherwise would be worse: streaming
  deltas stay non-durable. What a late subscriber recovers is message-granular —
  aggregated assistant text, tool results and the full lifecycle — not the
  keystroke cadence that produced them. And the run store still takes no claim
  fence, so monotonicity is a single-writer guarantee; `generation` is what makes
  a second writer detectable rather than silent.

### Minor Changes

- 4df5cf1: `drainRuns` — the queue loop the cross-process claim shipped without

  `claimRun`, `releaseRun`, the fenced `writeCheckpoint`, `listDurableRuns({ claimed: false })` and `resumeRun({ claimFence })` were all already here, and nothing outside the store's own tests called any of them. The two things the claim was built for — an approval inbox and a crash sweeper — still needed every host to write the same loop, including the two parts a host writes wrong: the release that belongs in a `finally` so a FAILED run goes back on the queue too, and the `null` claim that means "somebody got there first" rather than an error.

  New: `drainRuns({ store, scope, holder, ttlMs, onRun, park?, signal?, maxConcurrent?, pageSize?, now? })`, plus the types `DrainRun`, `DrainRunsParams`, `DrainRunsResult`, `DrainFailure` and the constant `DEFAULT_DRAIN_PAGE_SIZE`. One bounded pass: list what nobody holds, claim it, hand it to your callback with its claim, release it. No timers, no processes, no `while (true)` — running it again is your scheduler's job.

  **Read this before relying on "exactly once".** Two drainers never hold one run at the same time; that is absolute. Exactly-once over a pass is weaker and comes from the FILTER, not the claim: a listing is a snapshot, so between paging a row and claiming it another drainer can finish that run and release it. A claimed row is therefore re-read against `park` before any work starts, and one that no longer matches comes back as `stale`. An inbox drain (`park: ['outstanding']`) whose work answers the park is exactly-once. **With no park filter there is nothing to re-check and two drainers can both process one run** — a checkpoint store holds no run status by design, so "already done" is a fact only your own run records carry, and a crash sweep intersects with them inside `onRun`.

  A store missing `listDurableRuns`, `claimRun` or `releaseRun` is refused with `capability_unavailable` **before anything is listed**, naming all three. It never degrades to "claimed by default", which would let every worker proceed on every run.

  `@namzu/cli` gains `namzu drain --store <dir> --tenant <id> --project <id> --session <id>`, which claims each unheld run under that scope and continues it from its last checkpoint under that claim's fence. It is one pass and then exit: `namzu serve` still answers that namzu has no daemon, and this command is the shape that refusal implies — something your scheduler runs, not a service namzu owns. A run parked on a human decision is reported, never resumed past. Additive on both packages; nothing existing changes behaviour.

- 5dc8b82: Publish the checkpoint-store conformance suite at `@namzu/sdk/testing`

  `CheckpointStore` is an interface a host is expected to implement, and the
  in-memory store's source calls itself "the reference a host reads when writing a
  backend of its own". That claim was unbacked. Two days before this change the
  two shipped implementations disagreed at the enforcement point — the in-memory
  one accepted a checkpoint from a worker that had been superseded and then
  released around, the disk one refused it — and the class documented as the
  reference was the one carrying the defect. Nothing threw, nothing logged, and a
  completed worker's checkpoint was silently replaced by a dead worker's. A host
  writing its own backend had no way to find that out.

  New: a `./testing` subpath exporting `defineCheckpointStoreConformance` and
  `CHECKPOINT_STORE_CONTRACT_VERSION`. Nothing existing changes; the package's one
  existing export is untouched.

  ```typescript
  import { describe, expect, it } from "vitest";
  import { defineCheckpointStoreConformance } from "@namzu/sdk/testing";

  defineCheckpointStoreConformance({
    describe,
    it,
    expect,
    label: "my-backend",
    contractVersion: 1,
    capabilities: { claims: true, listing: true, multiTenant: true },
    makeStore: async (binding) => ({ store: await MyStore.connect(binding) }),
  });
  ```

  The suite takes `describe`, `it` and `expect` as arguments, so it binds to no
  test runner and installing `@namzu/sdk` pulls in no test dependency. It
  covers the four rules the types cannot state and the two built-in stores
  actually diverged on: claim exclusivity, claim expiry, refusal of a fenced-out
  write, and listing scope isolation across tenants. `capabilities` names what
  your backend can do so the suite asks only what it can answer.

  **Take note before you wire it in.** Once you do, every assertion in the suite
  is something your build fails on — so the suite's assertions are public API from
  here, and tightening or adding one is a `major` for this package rather than a
  `minor`, even though it adds no export. `contractVersion` is the seam that makes
  such a bump legible: write the number as a literal (do **not** re-export the
  constant, which makes the check unfailable), and a contract revision then fails
  with `expected 'checkpoint-store contract v1' to be 'checkpoint-store contract
v2'` instead of a scatter of assertion failures whose common cause is not
  obvious.

  Documented at `docs/sdk/runtime/checkpoint-store-conformance.md`.

## 20.4.0

### Minor Changes

- 249e1e5: Parked runs can now go on a queue with more than one reader.
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
  import { claimRun, listDurableRuns, releaseRun } from "@namzu/sdk";

  const page = await listDurableRuns(
    store,
    { tenantId },
    {
      park: ["outstanding"],
      claimed: false, // only what nobody is working on
      orderBy: "createdAt", // oldest first
    }
  );

  for (const entry of page.entries) {
    const claim = await claimRun(store, entry, {
      holder: "worker-3",
      ttlMs: 60_000,
    });
    if (!claim) continue; // somebody else got there first — not an error
    try {
      await drainQuery({ ...params, claimFence: claim.fence });
    } finally {
      await releaseRun(store, entry, claim.fence);
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

  Closing it needs the run store to become injectable and fence-aware. It is now
  injectable — `QueryParams.runStore` — and it is still not fence-aware: no
  method on `RunStore` takes a fence, so injecting one does not close this. Until
  it does, treat a claim as protecting the state a resume reads and assume the
  settle-time artefacts are last-writer-wins. If that is not good enough for your
  deployment, keep one writer per run.

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
  winner, the counter cannot rewind across a release, and a body nobody can
  parse never hides the ordering.

  It publishes that name with `link`: the body is written to a scratch name in
  the same directory and the fence name is created as a second reference to it.
  A plain exclusive create is open-then-write, so the winning name exists empty
  for an instant, and a reader landing there reports a live holding as expired —
  which puts a second worker on a running run, with both restoring it and
  executing its tools before either is refused. Publishing through `link` means
  the name never exists before the body under it.

  **This needs a filesystem with hard links, and it says so rather than
  guessing.** The scratch file must be in the same directory as its destination
  (`link` across filesystems fails `EXDEV`), which the store handles. If the
  volume supports no hard link at all — some network and removable volumes —
  `claimRun` raises `capability_unavailable` naming the code the filesystem
  returned. It refuses rather than falling back, because the only fallback is
  the non-atomic create described above and a claim that silently stops being
  exclusive is worse than one that will not start: the host cannot tell which it
  got. Put the base directory on a filesystem with hard-link support, or run a
  single writer per run. This case is unmeasured — no such volume was available
  to test — and the error says so instead of implying a diagnosis.

  **If you implement this yourself**, four properties the fence comparison
  depends on and none of which the kernel can check: a fence must exceed every
  fence ever issued for that run, including across a release; fences must be
  unique, because the check is `<` and equality admits both holders; the check
  must be atomic with the write; and `holder` must be unique per process, since
  it is the only thing separating a renewal from a theft. They are on the
  `claimRun` doc comment in full.

  `InMemoryCheckpointStore` implements it too, and is single-process by
  construction — use it for tests and single-writer hosts, not for two workers.
  It enforces the fence against the same high-water mark it mints from, so the
  two shipped stores refuse exactly the same writes. They did not, briefly, and
  the divergence was worth naming: the in-memory store checked the _live_ claim,
  which a release deletes, so a worker that stalled could still write after
  another worker had reclaimed the run, finished it and released cleanly. That
  is not a duplicate — it is a **silent loss**, because the stale write carries a
  fresh timestamp and becomes what the next resume restores. A host writing its
  own backend reads the in-memory store as the reference, so check the
  high-water mark, not the current holding.

## 20.3.0

### Minor Changes

- 85ddf3c: A run's own evidence can now be pointed somewhere other than the local disk.
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

## 20.2.0

### Minor Changes

- d9cbbfe: An approval inbox can now be triaged. `listDurableRuns` takes
  `orderBy: 'createdAt'` and returns runs oldest first, so "which run has been
  waiting longest" has an answer.

  It could not before, and the reason was structural rather than an oversight.
  A cursor has to sort on a key that cannot _move_, or a paging caller skips
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

## 20.1.0

### Minor Changes

- 6d29b12: You can now ask the checkpoint store which runs are waiting on a human, or
  which parks nobody answered in time, without already knowing their run ids.

  `CheckpointStore.listDurableRuns(scope, options)` lists every run with
  durable checkpoint state under a **contiguous prefix** of tenant → project →
  session, filtered by park state (`outstanding` / `expired` / `resolved`),
  paged with `limit` and `cursor`. Reach it through the exported
  `listDurableRuns(store, scope, options)` helper. An approval inbox is one
  call with `{ park: ['outstanding'] }`; the reclamation sweep that
  `hitlParkTtlMs` documents is the same call with `['expired']`.

  **Nothing you have implemented breaks.** The method is optional on the
  interface, so an existing custom `CheckpointStore` still satisfies it. If
  you call the listing against a store that does not implement it, you get a
  `capability_unavailable` error rather than an empty page — an empty page
  would read as "no runs are parked" when the truth is "this store cannot
  tell", and an inbox built on that answer never fires.

  Also new:

  - `InMemoryCheckpointStore`, exported. It is the reference for writing an
    attribution-keyed backend, and unlike the disk store it holds more than
    one tenant.
  - `DiskCheckpointStore` takes an optional second constructor argument
    carrying `tenantId`, `projectId` and `sessionId`. The disk layout records
    none of them, so a store built without it can persist checkpoints and
    refuses to list them rather than stamping rows with a guessed tenant. The
    kernel's own default store passes them, so runs started through `query()`
    are listable with no change on your side.
  - New types: `CheckpointListingScope`, `DurableRunEntry`, `DurableRunPage`,
    `ListDurableRunsOptions`, `ParkState`, `ParkSummary`,
    `DiskCheckpointStoreAttribution`.
  - The three helpers a backend of your own actually calls, so it inherits the
    park precedence, the ordering and the scope refusal instead of re-deriving
    them: `toDurableRunEntry`, `paginateDurableRuns`,
    `assertContiguousListingScope`.

  Two behaviours to know before you build on the listing. Rows are ordered by
  `runId`, not by time: a cursor must sort on a key that cannot move, and
  every timestamp derivable from checkpoints moves. And a row carries no run
  status, because a checkpoint is written mid-flight and this store genuinely
  cannot tell a run that finished from one that died — a crash sweep lists
  every run with durable state and intersects it with your own records.

  Deprecated: `RunDiskStore.listRuns`. It still works and is removed in the
  next major. Its entries carry no tenant, project or session, so a row cannot
  be turned back into an addressable scope; its writer skips every sub-run, so
  an inbox built on it drops every approval raised by delegated work; and it
  catalogues runs that started rather than runs with resumable state. Move to
  `listDurableRuns`, which answers all three.

  One behaviour change inside the disk store: a checkpoint file that vanishes
  between the directory listing and its read now throws instead of returning
  an empty array. The old shape discarded every checkpoint it had already
  parsed and reported the run as having none, which for a parked run reads as
  "no approval is pending".

## 20.0.0

### Major Changes

- ce51f5c: **A delegated agent's structured output now reaches its caller.** A supervisor
  that fanned out to five schema-configured specialists received five _strings_ —
  the model had to re-parse prose it had just caused to be serialized, and the
  host got no typed handle on any child's answer.

  Nothing was missing from the runtime. `Run.structuredOutput` has carried the
  parsed, validated value throughout, and the eval harness reads it correctly;
  every ergonomic boundary above it dropped the value three lines from its
  caller. This connects them:

  - **`BaseAgentResult.structuredOutput`** — archetype results carry the value,
    so `ReactiveAgent.run()` no longer returns `result?: string` and nothing else.
  - **`runAgent` can ask for a schema.** It never forwarded the config, so the
    most convenient way into the kernel was the one way that could not produce a
    typed answer. The validated value comes back on `RunAgentResult.structuredOutput`.
  - **Both delegation surfaces return the object.** `Agent` and `create_task`
    each prefer the child's structured answer over its prose. Both, because the
    last time a rule lived at one delegation site only, `create_task` shipped
    without the success check `Agent` already had.
  - **It survives a reload.** `run.json` now persists `structuredOutput`, so a run
    fetched by id still has the thing it was run for.

  **What is major: `run.result` now holds the serialized structured value.**
  Previously the structured exit deliberately did not set it, and result
  resolution walks back from the message tail and stops at the first
  non-assistant message — so a structured run, whose last assistant turn is a tool
  call rather than prose, kept whatever text an _earlier_ turn happened to
  produce. A host reading `run.result` got a sentence from the middle of the run
  presented as its answer.

  The other two options are worse. Leaving it is a stale value read as a fact,
  which is the defect. Clearing it makes a run that plainly answered report no
  answer, so a host testing `if (run.result)` concludes nothing was produced.
  Serializing is also what every text-shaped consumer needed anyway — the
  transcript, `Run.result`, and both delegation tools handing a child's answer to
  a parent model — and doing it once, where the value is known, replaces three
  slightly different serializations.

  **If you relied on the old behaviour**, read `run.messages` for the model's last
  prose; `run.result` on a structured run is now `JSON.stringify(structuredOutput)`.
  Runs without a schema are unchanged.

### Minor Changes

- 56c7d3a: **A tool result can now be sanitized without being reported as a failure.**
  `PluginHookResult` gains `{ action: 'replace', output, content? }` for
  `post_tool_use`.

  The substitution seam already existed and was typed as a failure channel: the
  only way a hook could change what the model sees was `action: 'error'`, which
  prefixes `Error: ` and sets the error flag. So redacting a credential out of a
  **successful** result was delivered to the model as a tool failure — and a model
  told a call failed routes around it, retrying it or reporting to the user that
  it did not work. Redaction was reachable and unusable.

  `error` says the call went wrong. `replace` says the call went right and the
  model may not see all of it:

  - the error flag follows the **tool**, not the hook, so a successful call stays
    successful and a failed one stays failed even if a hook rewrites its message;
  - no `Error: ` prefix;
  - **rich content survives**, because the common case is redacting text from a
    result whose image is unaffected. A hook that needs the blocks gone passes
    `content: []` — and a hook redacting a secret that also appears in an image
    must, since the replace cannot inspect what it is preserving.

  `modify` was not reused: it carries `input` and belongs to the pre-call hooks,
  so one action would have meant two things depending on where it was returned.
  `replace` is rejected on `pre_tool_use` and on the lifecycle events — loudly,
  because a hook author who returned it there meant to redact something and would
  otherwise watch the secret go through.

  **Minor rather than major**, deliberately, and here is the reasoning to
  overrule if you disagree: `PluginHookResult` is a type plugin authors
  **produce** and the SDK consumes, so widening it cannot break an author's
  switch — there is nothing for them to switch over. That is the opposite
  direction from the `RunEvent` widening in 12.0.0, which went major because
  consumers map every member exhaustively. The four exhaustive switches the
  compiler named for this change are all inside this package.

## 19.0.0

### Major Changes

- 3c0df0c: **The turn that produces the answer is now in the step ledger.** It was not.
  `if (forceFinalize || !hasToolCalls)` broke out of the loop before
  `recordStep`, so the ledger held only turns that called tools — and a run's
  last turn is its most expensive, because it carries the whole conversation as
  its prompt.

  **Why this is a fix and not a redefinition.** `StepResult` is documented as
  "what one iteration of the agent loop did" and `stepNumber` as "1-based,
  matching `iteration` on the run events". Every skipped turn emitted
  `iteration_completed` with its number, so the events said iteration N happened
  and `steps` had no entry N. The invariant was already false; nobody had chosen
  "turns that called tools" as a meaning.

  Measured on a two-iteration run — one tool call, then an answer — **220 of 330
  tokens belonged to no step**, and the unattributed share grows with context
  length. A text-only run, which is the commonest shape there is, produced an
  empty ledger.

  **What changes for you.** `run.steps.length` gains one entry for every run that
  ends by answering, and `onStepFinish` fires once more per run. Nothing stops
  compiling; the values change:

  - **If you compare step counts across this version, they shift by one.** A
    recorded baseline is not comparable — `stepBudgetScorer` in the eval harness
    is the in-tree example, and its own note says it exists because extra turns
    are "very visible on the bill". It was undercounting the bill by exactly the
    most expensive turn, so its new number is the correct one.
  - **Trajectory scorers are unaffected.** The added step has no tool calls, so
    `steps.flatMap(s => s.toolCalls)` is unchanged.
  - **`stopWhen`, `stepCountIs` and `hasToolCall` are unaffected in-run.** The
    predicate is consulted only after a tool batch, and the answering turn ends
    the loop before it.

  Also recorded now: the auto-continued turn after an output cutoff, the
  structured-output re-prompt, and an answer handed back by `reviewAnswer`. All
  three spend a turn and none of them left a trace.

  **Still not steps:** side calls. Compaction verification, the advisory
  executor and the retry after an empty completion spend tokens inside an
  iteration without being one, so they reach `run.tokenUsage` and no step. A run
  that makes them reconciles short by exactly their cost. Attributing those needs
  a record that is not a step, which is a separate change.

## 18.1.0

### Minor Changes

- d3bd080: A wrong API key is no longer reported as working

  Typing a key into the picker ran a check that could not fail for two providers.
  Measured against deliberately invalid keys, both said the key was good.

  **With an OpenRouter key, any string at all passed.** A typo, the wrong
  clipboard entry, a revoked key — all were accepted and reported as verified. The
  check listed the model catalogue and treated a successful list as a passed
  check, and OpenRouter's catalogue endpoint does not authenticate, so it answered
  the same way whatever was sent. Nothing was wrong with that driver's listing; a
  catalogue was simply never evidence about a key.

  **With an Anthropic key, a real rejection was discarded.** The listing caught
  the `401` and returned a hardcoded three-model list, which the check read as
  success — so the truth existed, was thrown away, and was replaced by something
  that looked like an answer.

  A credential check is now a separate, declared capability. A driver that
  declares no probe is reported as **not checked**, never as verified, so a driver
  added in future cannot silently inherit a check it does not perform. Anthropic,
  OpenRouter, OpenAI and Ollama declare one; OpenRouter's asks about the key
  rather than the catalogue.

  Refusal and doubt stay distinct. A `401` means the key is genuinely refused; a
  timeout or a DNS failure means nothing was learned, and is reported that way —
  telling someone on a broken connection to rotate a working key is a different
  error, not a smaller one.

  **Anthropic's model listing also never once ran.** The SDK method was pulled out
  of its namespace and called bare, so it lost `this`, threw a `TypeError` on
  every call, and was swallowed by the same catch — the hardcoded models were not
  a fallback but the only answer the method could give. It now calls the live
  endpoint, and falls back only when that genuinely fails.

  The four driver packages are `minor` rather than `patch`: each gains a method
  it did not have, and added functionality is a minor whatever the size of the
  diff. Anthropic's earns it twice over, because its listing now returns the live
  catalogue where it previously returned the same three hardcoded entries to every
  caller - so the value every existing caller receives changes.

## 18.0.0

### Major Changes

- 52b339e: **`ProviderRetryConfig.maxRetryAfterMs` now does what it documents.** It said
  "past this we surface the error and let the caller decide"; the code fell
  through to the ordinary jittered backoff instead, so a provider asking for a
  fifteen-minute wait was re-asked in half a second. The documentation was
  correct and the code was not.

  **What you see differently.** A server-directed `Retry-After` **greater than**
  `maxRetryAfterMs` (60s by default) now surfaces the provider error instead of
  retrying. A `Retry-After` at or under the ceiling is unchanged — still slept
  exactly as instructed — and a failure with no `Retry-After` at all is
  unchanged.

  Nothing settles differently. The error thrown is the same one the
  retries-exhausted path throws, carrying `retryAfterMs`, so a run that used to
  fail after four attempts now fails after one, sooner and with the number a host
  needs to schedule its own retry. What changes is the attempts in between: they
  were sent to an endpoint that had already said it would not serve them, and
  they cost the run its budget to rediscover a rate limit it had been told about
  in advance.

  **If you relied on the old behaviour** — on a provider whose `Retry-After` is
  routinely longer than you are willing to wait, and which serves anyway if you
  ask again immediately — raise `maxRetryAfterMs` past that value to keep
  retrying, or set it low and handle the surfaced error. There is no setting that
  restores "ignore the header and back off short", because that was the defect.

  **With a provider chain this is where the ceiling pays.** A rate limit is a
  fact about the member, not the request, so surfacing it advances the chain to
  the next member at once rather than after the primary's whole retry budget is
  spent.

- 5be5007: **The run record names the member that served.** After a provider chain fell
  over, `run.metadata.provider` and every step's `model` still named the head. The
  wire and the metering followed the member that answered; the durable record did
  not, so a run read back six months later said the primary served a turn it never
  saw. A missing field reads as unknown and a wrong one reads as a fact.

  **What is major: `StepResult.model` reports a different value.** It now names
  the model the step **asked for** — the run's configured model, or a
  `prepareStep` override. It used to be the run's model unconditionally, so a host
  that routed one step to a cheaper model read the expensive one back out of the
  ledger. That defect needed no chain to see. Nothing stops compiling; the value
  changes. If you were reading `step.model` to recover the run's configured model,
  read `run.metadata.config.model`, which has always held it.

  **New, and additive:**

  - `StepResult.servedBy` — `{ providerId, model, chainIndex }`, who actually
    answered the step. Equal to `model` and to `run.metadata.provider` on every
    run without a chain; it diverges exactly when the chain advanced.
    `chainIndex` is the member's position in the chain you declared (`0` is the
    head) and is carried because a chain may name the same provider twice with
    two models, which `providerId` alone cannot tell apart.
  - `RunStateMetadata.servingProvider` — the member the run was routed to at the
    end, absent when the configured provider served throughout.
    `RunStateMetadata.provider` is unchanged and still names what you configured:
    what was asked for and what answered are two facts, and collapsing them into
    one field is how the original defect was made.
  - `WithProviderFallbackOptions.onSwap` and the `ServingMember` type, for a host
    composing `withProviderFallback` itself.

  **Two limits, stated rather than papered over.** The loop records a step only
  for a tool-calling turn, so the turn that produces the final answer is not in
  `steps` — on a chain that falls over and answers immediately,
  `metadata.servingProvider` is the only record of the swap. And the built-in disk
  store writes `metadata`, not `steps`: per-step provenance reaches you on the
  returned `Run`, so persist that if you need it.

  **Nothing is backfilled.** Records written by 17.0.0 could fall over without
  recording it, so their `servedBy` is absent and their `servingProvider` reads as
  "no swap" whether or not there was one; the transcript's `provider_fallback`
  events are the record for those runs. Filling them in from the declared head
  would state as fact the exact thing that release got wrong, on exactly the runs
  where it was wrong.

## 17.0.0

### Major Changes

- 8348589: **A declared provider chain now falls over.** It was validated, doctor-checked and capability-refused, and nothing ever used it — `providers[1..N]` were decoration. They are not any more.

  **If you have one provider, nothing changes.** A one-member chain composes to exactly the previous behaviour, byte for byte, and emits no new events.

  **If you have declared fallbacks, they will now be used.** Your primary still gets its full retry budget first, and a `Retry-After` is still honoured before anything moves — but a rejected credential, a missing model, an exhausted rate limit or an outage now advances to the next member instead of failing the turn. The scope is the turn: your next message starts at the primary again.

  namzu will not fall over on a failure that is a property of your _request_ — a context overflow, a rejected request, a refusal — because the identical request fails identically on the next provider.

  **Every swap is announced.** A new `provider_fallback` run event, `provider.fallback` on the wire, and a transcript line in the CLI naming the member that failed, why, and the member now serving.

  **That announcement is why this is a major.** `RunEvent` and `StreamEventType` are wider, so a consumer that switches exhaustively over either — with no `default` and a `never` check — stops compiling until it adds an arm. That is not a hypothetical: the SDK's own A2A mapper, SSE mapper and run reporter all do it, and the compiler named all three in this change, exactly as it did in 12.0.0 when `plan_completed` and `plan_failed` were added and that release went out as a major for this reason. Widening a union a consumer reads is a break in this repo whatever the ecosystem convention is; the fix is one `case` per new member.

  **A fallover loses the prompt cache**, so the rest of the turn re-reads your whole context at full price. That is the largest single cost of running a chain and it is worth ordering the chain accordingly.

  **Breaking for one combination, and only that one:** `query()` now throws `invalid_config` when `pricing` is passed together with a chain of more than one member. One pricing table cannot price two members, so the reported total — and `runConfig.costLimitUsd`, which is enforced from it — would be wrong by an unbounded margin and silently so. To keep pricing, declare one member; to keep the chain, drop `pricing`. No existing caller can hit this, because the chain is only reachable through the new `fallbackProviders` option.

  New in `@namzu/sdk`: `withProviderFallback`, `ProviderChainMember`, `WithProviderFallbackOptions`, `QueryParams.fallbackProviders`, `StreamChunk.fallback`, `ProviderFallbackNotice`.

  A fallback with no credential is left out of the chain and named at launch, rather than discovered as a 401 on the day your primary goes down. Sub-agents resolve their provider independently and do not inherit the chain.

## 16.0.0

### Major Changes

- 61b5cc8: `parseFrontmatter` refuses a block-sequence list instead of silently dropping it.

  ```yaml
  ---
  allowed-tools:
    - Read
    - Bash
  ---
  ```

  Those lines carry no `:`, so they were skipped, and the key came back **absent**
  — not empty, absent. Meanwhile the flow form `[Read, Bash]` threw. One spelling
  of a list was a hard error and the other was silence, and the silent one is the
  spelling people actually write, because the block form is the natural YAML for
  a list.

  **What breaks.** A file whose frontmatter uses a `- ` list now throws where it
  previously parsed. If you load skills or commands from files you did not write,
  one of them may start being refused.

  **What to do.** Write the value on one line:

  ```yaml
  allowed-tools: Read, Bash
  ```

  The error names the key and the file.

  **Why this is worth a major rather than left alone.** The file that now throws
  was never working. `allowed-tools` is a capability list: a skill that asked for
  `Bash`, had the request silently discarded, and ran without it is
  indistinguishable — from the author's side and from the log's — from a skill
  that never asked. That is a capability quietly not granted, which is worse than
  a file that will not load, because the second one tells you.

  In `@namzu/cli` this surfaces as it should: the skill is listed with `⚠` and the
  parse error rather than disappearing, and the rest of the roster keeps working.

  Not affected: an ordinary indented mapping still parses, and a hyphen inside a
  value — `description: a - b` — is prose, not a list, and is left alone.

## 15.1.0

### Minor Changes

- b31a41f: Added `parseFrontmatter`, the one reader for a markdown file's `---` block, with
  its `ParsedFrontmatter` result and `FrontmatterValue` types.

  ```ts
  import { parseFrontmatter } from "@namzu/sdk";

  const { values, body } = parseFrontmatter(raw, `command at "${path}"`);
  // values: {
  //   description:     { kind: 'scalar',  value: 'Open a pull request' },
  //   'argument-hint': { kind: 'scalar',  value: '<branch>' },
  //   metadata:        { kind: 'mapping', entries: { author: 'someone' } },
  // }
  // body: everything after the closing fence, trimmed

  const description = values.description;
  if (description?.kind !== "scalar")
    throw new Error("description must be a scalar");
  ```

  **One entry per key, discriminated on `kind`.** A key is a scalar or a
  one-level block, never both — no YAML file can express both, so the type does
  not let you represent it and the parser refuses a file that tries (a value
  _and_ indented lines under the same key). Two parallel maps would have made
  every caller invent a precedence for a case that cannot arrive, and quietly
  punished the ones who did not.

  **Why you would want it.** If you read your own markdown — command files,
  prompt templates, anything with frontmatter — you were writing a second reader.
  There were three in this project and two of them disagreed on the same input:
  one **threw** on malformed frontmatter and another **silently returned no
  metadata**, so one file was a hard error on one path and, on the other, a skill
  named after its own directory described as "(no description)". This is the one
  that stays.

  **It refuses rather than degrades.** Absent frontmatter, an unclosed fence, or
  YAML this reader does not implement — a block scalar (`>`/`|`), a flow sequence
  (`[a, b]`), a flow mapping (`{a: b}`) — all throw, and the message names your
  `source` label and the offending key. It never returns an empty or partial
  result to stand in for a file it could not read. Pass whatever `source` string
  makes your errors read correctly; it is used verbatim.

  **It parses CRLF.** A file authored on Windows is the ordinary case. Be aware of
  what this does and does not claim: `loadSkill` already handled CRLF correctly,
  so this is not a repair on the SDK side — the defect was in a separate
  first-party copy whose regex required LF and which therefore dropped the
  frontmatter of every Windows-authored file without failing. CRLF is now covered
  by tests that fail if it regresses, on a property that was true and untested.

  **Frontmatter keys cannot reach the prototype chain.** Keys come from a file,
  which is untrusted input, so `__proto__`, `constructor` and `toString` are
  stored as ordinary data and cannot write to `Object.prototype`. Worth stating
  because the first cut of this export got it wrong: a `__proto__:` block wrote
  straight through to `Object.prototype`, and the poison then surfaced in the
  metadata of an unrelated skill loaded later in the same process. Caught before
  release; covered by tests.

  **It does not know what your fields mean.** It returns the parsed map and
  validates no field names — a skill's vocabulary and a command's are different,
  and widening one to cover the other is how a skill-shaped API comes to mean
  something it does not. Your own validation stays yours.

  **Nothing about `loadSkill`, `discoverSkills`, `SkillRegistry` or
  `resolveSkillChain` changes**, with one disclosed exception below. They are now
  built on this reader, and that was checked rather than assumed: the pre-refactor
  loader and the refactored one were run side by side over 26 frontmatter shapes
  × both line endings — including a key carrying both a scalar and indented
  children, `metadata:` with a value _and_ children, children under a
  non-`metadata` key, duplicate keys, and indented lines before any key — and
  compared on returned metadata, body, token estimate, and thrown message. 52
  cases, no structural difference.

  **A third exception, from the shape above.** A `SKILL.md` whose key carried both
  a value and an indented block — `metadata: something` with `author: …` beneath
  it — used to load, with the value silently discarded. It is now refused, naming
  the key. The discarded half is why: the file said two things and the loader only
  ever honoured one, so the author had no way to see which.

  **A second exception, and it is a fix.** A file using lone-`CR` line endings
  (classic Mac, pre-2001) used to be read as one single line, which collapsed the
  whole frontmatter into the first key — `name` came back as
  `"a-skill\rdescription: d"`. `loadSkill` then refused the file with
  `missing required field: description`, because the collapse leaves no
  `description` key at all. Such files now parse correctly. Nothing that worked
  before stops working: the only files whose outcome changes could not load at
  all. It mattered enough to fix because a caller doing its own validation —
  which is the whole point of this export — would have accepted the mangled name
  silently.

  **The one exception that is only prose.** The refusal message for unsupported
  YAML used to end _"Refusing rather than registering a skill whose `x` would read
  as …"_. It now ends _"Refusing rather than accepting a `x` that would read
  as …"_, because the reader is no longer only about skills and a command file
  refused with the word "skill" in the message is a worse error than the one it
  replaces. The prefix, the named key, the named construct, and the advice are all
  unchanged; only that clause differs. If you match on the full text of that
  message, adjust; matching on `/block scalar/`, `/flow sequence/` or
  `/flow mapping/` is unaffected.

  `discoverSkills` still finds only directories containing a `SKILL.md`; serving
  single-file layouts is a caller's job, and this export is what makes writing that
  caller reasonable.

## 15.0.0

### Major Changes

- 1cc83a5: Removed the task-progress reporting channel, which never had a producer: the
  `progress_updated` variant of `AgentLifecycleEvent`, the `AgentTask.progress`
  field, and the `AgentTaskProgress` type.

  **What breaks.**

  - `AgentLifecycleEvent` no longer includes
    `{ type: 'progress_updated'; taskId: TaskId; progress: AgentTaskProgress }`.
    A listener with a `case 'progress_updated':` branch is now a type error, and
    an exhaustive `switch` over the union will fail to compile until that branch
    is deleted.
  - `AgentTask.progress` is gone. Reading `task.progress` is now a type error.
  - `AgentTaskProgress` is no longer exported. An annotation naming it will not
    resolve.

  **What to do instead: delete the code that touched them. Nothing replaces it.**
  All three were one channel and nothing in the SDK ever drove any part of it —
  no emit site for the event, no write to the field. A `case 'progress_updated':`
  branch has never executed, and `task.progress` has been `undefined` on every
  task that has ever existed. If you were waiting on progress to arrive, you were
  waiting on something that could not come; this release stops advertising it, it
  does not change what your code observes at runtime.

  Both declarations carried `@deprecated No producer. Removed in the next major.`
  in a shipped release, so this is that deprecation being honoured on schedule
  rather than a surprise removal.

  If you need per-task progress, the live surface is the run event stream —
  `tool_progress` carries a tool's own progress messages, and the activity store
  (`activity.progress`) carries structured activity updates. Neither is affected
  by this change.

  **Why removal rather than building the producer.** Emitting it would be a new
  feature. Unlike the other producerless events in this codebase, this one has no
  half-built machinery waiting on it — no wire mapper case, no reporter case, no
  test fixture. There is nothing to finish, only a declaration to stop making.

  **Scope note, because a much wider removal was proposed and rejected.** This
  release was drafted against an audit finding of 23 "declared but nothing reads
  it" items. Most did not survive verification and are deliberately **not**
  removed: `memoizeAsync`, `toWireRunStatus`, `startBidiRun`,
  `createMockBidiProvider`, `createRunReporter`, `parseWorktreeList`,
  `compressShellOutputFull`, `bodySaysContextOverflow`,
  `classifyProviderHttpStatus`, `resolveSkillChain`, the `SkillChain` and
  `SkillLoadResult` fields, and `InvocationState.metadata` / `.services` /
  `.parentChain`. Several have callers inside this package, two are the entry
  points of the documented duplex runtime, and `InvocationState` is delivered
  intact to `ToolContext.invocationState` for a host's own tools to read. If you
  use any of them, this upgrade does not touch them.

### Patch Changes

- 48d9d67: Published tarballs no longer contain test files.

  `files: ["dist", "src", ...]` reads as "the build output and the sources" and
  means "everything the compiler emitted and everything in the tree", so every
  compiled test, its declaration, and both source maps shipped to the registry —
  and for the twelve packages that also ship `src`, the raw test sources went with
  them.

  Measured on the versions currently published:

  | package      | files       | of which tests | unpacked           |
  | ------------ | ----------- | -------------- | ------------------ |
  | `@namzu/sdk` | 3879 → 2239 | 1640 (42%)     | 12.73 MB → 6.81 MB |
  | `@namzu/cli` | 462 → 282   | 180 (39%)      | 1.21 MB → 0.73 MB  |

  Nothing you can import changes. Every package restricts `exports` to `"."`, so
  Node refused a deep subpath into those files already — they were weight in the
  tarball and nothing else. Hence `patch`: there is no consumer-visible surface
  here, only less to download.

  The exclusions are at the packaging layer, not the compiler. Adding `exclude`
  to `tsconfig.json` would have kept tests out of `dist` and also dropped them
  from `tsc --noEmit`, silently ending type-checking of the entire test suite —
  trading a packaging defect for a much worse one.

## 14.0.7

### Patch Changes

- ee1aa38: Remove references that pointed readers at a directory they can never open.

  Agent working memory in this repository is gitignored, and several published
  artifacts cited paths inside it. None of them resolved for anyone but the
  maintainer, and four cited session folders that no longer exist at all.

  What a consumer sees change:

  - `@namzu/sandbox` raised `Sandbox backend 'x' is not implemented yet. Track
progress in vendor/namzu/docs.local/sessions/ses_004-...` — a runtime error
    instructing the reader to open a path that is not in the package, not in the
    repository, and not on the internet. It now names what does ship instead.
  - `@namzu/computer-use`'s README linked to an adapter-pattern document under a
    directory that does not exist in any checkout. It now links to the two
    published pages that actually carry the adapter contract, the capability
    protocol, and the platform command matrix.
  - `@namzu/cli`'s README linked to a session folder on the code host that
    returns 404, to explain the doctor's protocol/runtime split. The split is now
    explained in the sentence itself.
  - `@namzu/sdk` source comments cited design documents by path. They cite the
    session by name instead, which is what the reference was ever worth.

  No API, type, or behaviour change. The `@namzu/sandbox` message text is the
  only runtime string affected, and nothing asserts on it.

## 14.0.6

### Patch Changes

- 9ee23f1: Stop the package README naming two providers when seven ship

  "Provider abstraction. OpenRouter and AWS Bedrock today" has been wrong for a
  long time. Seven driver packages ship — and a reader deciding whether this
  kernel can talk to the service they already pay for was being told, on the
  registry page, that it probably cannot.

  That is the expensive direction for this particular sentence to be wrong in:
  it does not cause a bug, it causes someone to close the tab.

  Also removed the third-party product names from "What Namzu Is Not". That
  section explained namzu's scope by listing other people's products, which is
  the one thing this repository's own naming rule refuses — a design explained
  by reference to somebody else's has borrowed its shape, and the borrowing
  outlives the sentence. The scope boundaries are unchanged and now stated as
  categories: no front-end framework bindings, no web-framework or edge-runtime
  plumbing, no embedded vector engine.

  Prose only. No runtime change.

## 14.0.5

### Patch Changes

- a2a7aed: `LocalTaskGateway` stops remembering every task it ever launched.

  `trackedTaskIds` and `settledHandles` had `add` and `set` and no removal
  anywhere in the file. The comment above them said "bounded by the number the
  gateway itself launched", which is true and is not a bound: a gateway built per
  run is bounded by that run, but `SupervisorAgentConfig.gateway` lets a host
  supply its own, and a long-lived host reusing one accumulates an id and a
  settled handle for every task it ever launched, for the life of the process.

  Both are now capped at 1000 and evicted oldest-first. The cap is far above any
  realistic single run — a fan-out is eight, a long supervisory run is dozens —
  so the listing a supervisor reads at the end of its run is unchanged.

  The two are evicted **together**. Dropping a tracked id while keeping its
  handle would leave memory nothing can reach, since `listTasks` walks the ids;
  dropping a handle while keeping its id would make a task that ran read as one
  that never launched, which is the exact defect the settled-handle map exists to
  fix. Removing either half of the paired delete fails a test.

- 688d6af: Stop the package README promising filesystem isolation the sandbox refuses to claim

  The README that ships inside this tarball — and therefore the page on the
  registry — said tools run "inside an OS-enforced jail with deny-default file
  I/O", and attributed that to both sandbox tiers.

  `src/sandbox/isolation.ts` says otherwise, and says it deliberately. The
  namespace tier reports `filesystem: false`, because it unshares the mount
  namespace and never remounts anything, so the child still sees the whole host
  filesystem. The comment beside that table is explicit that claiming otherwise
  would reintroduce the exact defect the table exists to end.

  So the code was careful and the README was not, in the one direction that
  costs something. An overclaimed security control is worse than an absent one:
  a reader who believes a boundary is there stops looking for one, and this
  sentence was reachable from the registry page by anyone deciding whether it
  was safe to run untrusted input through a tool call.

  Nothing about the runtime changes. What changes is that the README now
  reproduces the isolation table per tier, names the tier that does **not**
  enforce filesystem isolation and why, and points at `assertIsolation`,
  `isolationOf`, `missingIsolation` and `describeIsolation` — which have always
  been exported, and which refuse a run whose required control the host cannot
  supply rather than quietly running it at a weaker tier.

  No action required on upgrade. If you read that sentence and concluded your
  tool calls were filesystem-confined on a namespace host, they were not — call
  `assertIsolation` with the controls you actually require, and it will refuse
  rather than pretend.

## 14.0.4

### Patch Changes

- b4a3fa7: `StdioTransport.close()` resolves when the child is gone, not when the signal
  was sent.

  It called `kill('SIGTERM')` and returned. `kill()` returns as soon as the
  signal is delivered, so an awaited `close()` meant "SIGTERM is on its way", and
  a caller that closed a transport and then deleted the child's working directory
  raced the exit — reported as `EBUSY` from a real integration, not inferred. A
  close that does not mean closed makes every teardown built on it a guess, and
  the guess is only wrong sometimes.

  `close()` now waits for the child's `exit`. A child ignoring SIGTERM is sent
  SIGKILL after two seconds, and a second timer gives up waiting, so `close()`
  cannot hang; both timers are unreferenced, so neither holds the event loop
  open. A spawn that never produced a process emits `error` and no `exit`, and
  that path settles too rather than waiting for an event that is not coming.

## 14.0.3

### Patch Changes

- c50f9bf: `ProjectManager.archive` refuses when it cannot establish the precondition.

  14.0.0 shipped archival that "refuses rather than cascading" — a workspace with
  a live session throws `ProjectNotEmptyError` instead of closing over running
  work. The check read the session list as
  `(await store.listSessionsByProject?.(...)) ?? []`, and `listSessionsByProject`
  is optional. So on a store that does not implement it, "this store cannot tell
  me what is running here" became "nothing is running here": the workspace closed
  over live sessions and the call returned success.

  It now throws, naming the missing method and what to do instead. Both stores in
  this package implement it, so nothing in-tree changes; a host with its own
  `SessionStore` gets a refusal where it previously got a wrong answer.

  The mistake is worth naming, because the two halves are each correct and only
  the combination is not. Optional-on-the-interface protects implementors: a
  host's own store should not stop compiling because the SDK grew a method. It
  cannot also mean a **safety precondition silently passes**. Where a store
  cannot answer the question the check exists to ask, the answer is a refusal,
  not a default.

## 14.0.2

### Patch Changes

- 9e03c89: `InMemoryTaskStore.block()` stops announcing an edge that already existed.

  The two task stores disagreed about what `task.updated` means. `block()` is
  idempotent on both — each guards its array against a duplicate entry — but only
  the disk store guarded the _announcement_. Calling `block(a, b)` twice emitted
  two `task.updated` events from the in-memory store and one from the disk store,
  which is the one a host runs in production.

  So a host rebuilding a dependency graph from the event stream did redundant
  work against the reference implementation and not the durable one, and a host
  counting events to detect change saw change where there was none. The
  divergence is the kind that stays invisible until a store is swapped.

  The disk store's behaviour was already correct and is now the behaviour of
  both. No event is lost: a call that establishes a new edge — including one that
  repairs a half-edge, where only one of the two arrays grows — still announces
  both ends, because both ends are one fact.

  The disk store's side of this had no test, which is why the disagreement
  survived. Both are now driven from the same cases.

## 14.0.1

### Patch Changes

- 25acd60: `requireOpenProject` is reachable from the package root.

  It was exported from the manager barrel and never re-exported by the package
  entry point, so `import { requireOpenProject } from '@namzu/sdk'` was
  `undefined` in 14.0.0 — found by running the published tarball rather than the
  working tree.

  `ProjectManager.requireOpen` always worked and covers the same check, so
  nothing was broken; what was missing is the shape the function exists for. A
  host writing its own ingress path — a custom handoff, a queue consumer that
  creates sessions — should be able to refuse a closed workspace without
  constructing a manager, which is precisely why the SDK's own three gates call a
  function over a store rather than a method on an injected collaborator.

## 14.0.0

### Major Changes

- 589bcfc: A closed workspace takes no new work.

  Archiving a workspace meant nothing to the code. `Thread` carried a status and
  `ThreadManager.requireOpen`; `Project` — the thing a tenant owns, configures,
  gives an environment, and actually closes — carried neither, so the kernel kept
  spawning agents into a workspace its owner had shut. This moves the archival
  invariant to the level that survives the Thread removal.

  **`Project` gains `status` and `ownerVersion`.** Breaking for anyone
  implementing `SessionStore` themselves: a `Project` you construct now needs
  both. Existing records on disk read as `open` at version `0`, which is what
  they were — leaving `ownerVersion` undefined would be worse than a wrong
  default, because every compare-and-set against it would fail and an existing
  workspace could never be closed.

  **New:** `ProjectManager` with `requireOpen`, `archive` and `reopen`;
  `SessionStore.setProjectStatus` and `SessionStore.listSessionsByProject` (both
  optional, so a host's own store keeps compiling); `ProjectClosedError`,
  `ProjectNotEmptyError` and `StaleProjectError`, all three exported — a host
  that closes a workspace has to tell "this workspace is closed" from any other
  spawn failure, and matching on a message string is not a contract.

  Three decisions worth naming.

  **The gate is a function over a store, not an injected manager.** The three
  ingress paths — spawn and both handoffs — already hold a `SessionStore`, so
  `requireOpenProject(store, ...)` needed no constructor change anywhere. A gate
  that requires new wiring is a gate somebody forgets to wire. In each path it
  _replaces_ the existing `getProject` + null check rather than adding a
  round-trip, because a gate that costs something is a gate someone eventually
  moves.

  **Status moves both ways.** A thread was archived forever. A workspace is
  long-lived and a mistaken close should not be permanent, so `reopen` exists.

  **Archiving refuses rather than cascading.** A workspace with a session in
  `active`, `locked`, `awaiting_merge` or `awaiting_hitl` throws
  `ProjectNotEmptyError` naming what is blocking. A live session is a running
  agent whose owner is still watching; closing its workspace out from under it
  would strand work. Settle the sessions, then close. Re-archiving an already
  closed, already empty workspace is a no-op that does not burn a version, so a
  retry cannot lose a race it is not in.

  Verified through the front door: the spawn case drives a real `AgentManager`,
  so the assertion cannot pass with the gate call deleted — removing it fails two
  tests. Calling the gate directly would only have proved the function throws.

- af9c29d: An id the SDK mints passes the schema the SDK exports.

  `ProjectIdSchema` was `/^prj_[a-z0-9]+$/`. The v0.2.0 filesystem migration
  mints `prj_legacy_<suffix>`. So the SDK's own exported validator rejected every
  project it had itself written to disk during a migration — a host that
  validated an inbound project id, which is the only reason the schema is
  exported, answered "Invalid project ID format" for its own data, with nothing
  saying the id had come from the SDK.

  The schema now accepts the two shapes the SDK mints and no others:
  `prj_<12 lowercase alphanumerics>` from `generateProjectId()`, and
  `prj_legacy_<suffix>` from the migration. It is deliberately narrower than the
  `ProjectId` type, which is `prj_${string}`; a host that supplies its own
  `SessionStore` and mints its own ids should validate with its own schema.

  **Breaking:** the migration now refuses a legacy `thd_*` folder whose name is
  not a thread id, where it previously migrated it. The migration is the one
  place a project id is built from data rather than generated, and a folder named
  `thd_Not An Id` produced `prj_legacy_Not An Id` — structurally a `ProjectId`,
  accepted by no validator, and thereafter a directory name in the new layout.
  `DefaultFilesystemMigrator.migrate` throws `FilesystemMigrationError` with
  `op: 'validate_thread_id'` and the offending path.

  If your store root holds such a folder, rename it to `thd_` plus lowercase
  alphanumerics before upgrading, or move it aside; the migration is idempotent
  and re-running it after the rename completes normally. Folders created by the
  SDK are always of that shape, so a store the SDK wrote is unaffected.

  It refuses rather than skipping the folder. Skipping would leave that thread's
  runs on disk and unaddressable, write the completion marker anyway, and return
  `kind: 'migrated'` with the thread absent from the list.

  Also documented, not changed: a `projectId` that `runAgent` generates names no
  `Project` record — it takes no store and creates nothing. Carrying one into a
  store-backed `AgentManager` is refused at the first delegation with
  `Project <id> not found for tenant <id> — spawn rejected`, which is the
  enforcement site behaving correctly, since delegation limits live on the
  project. A run that has to delegate should be given the id from
  `store.createProject()`. The `AgentIdentity` doc now says so.

### Patch Changes

- f605059: An MCP transport forgets its listeners when the session closes.

  `onMessage`, `onClose` and `onError` appended to arrays that nothing ever
  drained. `MCPClient.connect()` calls all three once each, and it is reachable
  again after `disconnect()` — the guard only refuses when the status is already
  `connected`. So every reconnect stacked another set on the last: after n
  cycles one inbound message dispatched to n handlers, n-1 of them closures over
  sessions that had ended. `rejectAllPending` and `emitLifecycle` fired n times
  per close, and each stale closure held its old client state alive for as long
  as the transport object did.

  All three transports clear their handlers now — **after** notifying, never
  before.

  The ordering is the whole fix. `HttpSseTransport` and `StreamableHttpTransport`
  call their close handlers inside `close()`, so they clear immediately
  afterwards. `StdioTransport` does not: its close handlers run from the child
  process's own `close` event, which arrives after `close()` has returned.
  Clearing there — the obvious one-line change — would mean nothing tells
  `MCPClient` the session ended, so its status would stay `connected` and the
  next `connect()` would be refused with "already connected". Its handlers are
  dropped after that event fires instead, with the never-spawned case handled
  separately so a retry after a failed spawn does not stack a second set.

  Not changed, and worth knowing: the two HTTP transports disagree about closing
  a transport that was never connected — streamable returns early and notifies
  nobody, http-sse notifies regardless. Making them agree changes what a host
  observes and deserves its own decision.

## 13.1.0

### Minor Changes

- 449d736: A workspace can be configured, listed, and reconfigured.

  Every Project in existence ran at delegation depth 4 and width 8. The config was
  hardcoded identically in both stores, `CreateProjectParams` was
  `{tenantId, name}`, and there was no way to write one afterwards — so a tenant
  with several workspaces could not give them different limits, which is most of
  what having several workspaces is for.

  `CreateProjectParams` gains `config`, and `SessionStore` gains `updateProject`
  and `listProjects`.

  **Only the fields something reads are settable.** `ProjectConfig` declares
  eight; five enforcement sites read two of them. The other six have zero
  production readers — `maxInterventionDepth` included, whose three apparent hits
  are all comments describing a wiring that does not exist. Exposing those would
  make a dead field _easier to set_: a host would configure a retention policy,
  get no error, and believe retention was on. `ProjectConfigInput` is therefore
  exactly `maxDelegationDepth` and `maxDelegationWidth`, and a field joins it in
  the same change that gives it a reader.

  **Both new store methods are optional.** Widening a store interface is invisible
  to callers and fatal to implementors: a host with its own `SessionStore` should
  not stop compiling because the SDK grew a method. Both stores here implement
  them; callers check.

  Two decisions worth naming. An update is applied **per field**, so a caller
  raising the width is not silently resetting the depth — including when a key is
  present but `undefined`, which is the shape a caller building an update object
  programmatically produces. And `listProjects` **omits** another tenant's
  projects rather than refusing: a listing is a question about what you own, and
  refusing would confirm that somebody else's project is there. Writing to one
  still throws.

  `listProjects` returns **oldest first, ties broken by id**. The tie-break is
  load-bearing rather than tidy: `createdAt` has millisecond resolution, several
  workspaces created in one millisecond is ordinary, and without it the rest of
  the order came from the directory. A caller paginating a listing that reorders
  under it sees one project twice and another not at all.

  Verified live against a real run, not only in tests: a workspace created with
  `maxDelegationWidth: 1` refuses the second concurrent delegation with
  `Delegation capacity exceeded: width 2/1`, and the same workspace at width 5
  runs all four.

- c13e7b6: An environment reaches the child it was set for.

  `AgentManager` builds a delegated child's config on two branches. The
  bare-config branch — taken only when a definition has no `configBuilder` — has
  always carried `env`. The `configBuilder` branch, which is what a host
  registering a real agent actually uses, never stamped it. So a run given an
  environment handed its delegates none of it, and the child ran against whatever
  the ambient defaults were.

  This is the third field to go the same way. `parentSpan` and `resumeHandler` are
  both stamped after the builder returns, each with a comment saying the builder is
  written by whoever registered the agent and cannot be expected to forward
  something it was never told about. `env` was missed, and it went unnoticed
  because a missing environment does not fail — the child just runs somewhere else.

  Both delegation surfaces now forward the parent's `ToolContext.env` as a
  `configOverrides.env`, and the manager merges it **per key** rather than
  replacing the map: `configOverrides` is a `Partial`, so assignment would drop
  every key the builder set and the caller did not restate. The override wins per
  key, the same direction it already wins for `model`, `thinking` and `effort`.

  **Widening worth naming:** a delegating agent's `config.env` now reaches every
  descendant, on both surfaces. That is what setting an environment was for, and
  it is a behaviour change for anyone who had been relying on delegates not
  inheriting one.

  **`env` is for configuration, not credentials**, and the contract now says so
  where it is declared. The map is copied into every descendant, is readable by
  any tool, and enters a model's context and the run transcript the moment a
  command echoes it — properties of the channel, not a judgement about any
  particular value. A value that authenticates to a host belongs on the brokered
  credential path, where the process holds a placeholder and the value is attached
  at egress.

  No new field on `ProjectConfig`. It already carries six fields nothing reads,
  and a workspace environment does not need a seventh: the mechanism is the
  environment a run is given, which now actually propagates.

## 13.0.0

### Major Changes

- 5aae875: A delegated child releases its workspace when it succeeds, not only when it fails.

  `AgentManager` had two workspace dispose sites and both were failure paths — the
  non-success branch of `finalizeChild`, and the rollback in `failSubSession`. The
  success branch disposed nothing, so a git worktree provisioned for a delegated
  child outlived the child that used it. `.namzu/worktrees/` grew once per
  successful delegation: the more reliable the workers, the faster it filled,
  which is the opposite of the signal a leak usually gives.

  Disposal now runs on every terminal path, from one shared place, so the two
  cannot drift apart again.

  **The archival backstop could not fire either, and now can.**
  `ArchivalManager.archive` resolves a workspace only when `SubSession.workspaceId`
  is set. For a spawn-created sub-session that field was written `null` and never
  updated — `provisionSpawn` kept the ref on an in-memory record and nowhere else
  — so the one persisted record that could have named the leaked worktree said
  there was none. `provisionSpawn` now writes `workspaceRef.id` onto the
  sub-session, inside the same compensating rollback as every other mutation
  there. A sub-session with no provisioned workspace still records `null`; lazy
  provisioning stays legal.

  Two consequences worth knowing before you take the upgrade:

  - **A worktree is gone once the child that owned it completes**, and this is the
    breaking part. Reading a child's workspace after a successful delegation
    worked — `AgentManager.getSpawnRecord(taskId).workspaceRef` returned a live
    ref, and the directory then persisted indefinitely because nothing removed
    it. That was the leak, but a host inspecting a worker's artifacts afterwards
    could reasonably have been built on it.

    There is no host-side replacement, so take what you need from inside the
    child: have the worker write its output where the result can carry it, or
    copy the files out before its run settles. In particular a `subsession_idled`
    listener is **too late** — disposal runs before that event is emitted,
    deliberately, so nothing can reach into a workspace that is already going.

  - **`archive()` now resolves workspaces for spawn-created sub-sessions.** If you
    pass a `workspaceResolver`, it will start being called on this path, and an
    archive bundle may now carry a `workspace` field where it previously never
    did. The resolver contract is unchanged: return `null` for a ref that is
    unknown or already disposed, which is what it will be for a child that
    finished.

### Minor Changes

- fbfb061: A session has one writer, and the store is what enforces it.

  `Session.ownerVersion` is documented as the compare-and-set counter for handoff
  and nothing enforced it. Both stores overwrote unconditionally, so the only
  check lived in the handoff path — where it compared `source.ownerVersion`
  against the assignment after `blockingRun`, `getProject` and `validateDepth` had
  all awaited in between, which is a snapshot compared against itself. Worse, the
  lock transition wrote `status: 'locked'` at the version it had read, so the
  locked window was invisible: a second handoff holding the same snapshot saw an
  unchanged version, passed the check, and locked the session again. Both
  provisioned a worktree and one silently erased the other.

  `ThreadStore` has had a working CAS since it was written. `SessionStore` now
  does too.

  **`updateSession(session, tenantId, expectedOwnerVersion?)`.** Supply it and the
  store compares against the version it HAS STORED — not against the payload,
  which is the caller's stale copy — and throws the new `StaleSessionError`
  instead of writing. Omit it and behaviour is exactly what it was, which is the
  compatibility promise.

  The parameter is optional deliberately. Widening the interface is invisible to
  callers and harmless to a host implementing its own store; a required parameter
  would break every implementor for a guarantee they can opt into.

  **The handoff lock now moves the version**, which is what makes it a lock, and
  the commit keeps it rather than taking a second — so a handoff still consumes
  exactly one version and `committedOwnerVersion` is unchanged. Only the
  intermediate state changed, and that is the state that had to become visible.
  Both the single and broadcast paths.

  `StaleSessionError` is exported. A host that opts into the CAS has to tell
  "somebody else took this session" from any other failure, and string-matching a
  message is not a contract.

  **In-process only, and stated rather than implied.** `DiskSessionStore` writes
  atomically but its read-compare-write is not a critical section, so two
  processes can still both pass. Closing that needs a lease with an expiry — not a
  PID registry, because a Session is durable and written from hosts where a PID is
  not a checkable fact. The contract says so where a caller will read it.

### Patch Changes

- 9b01a9e: A2A's `contextId` is a Project, and now something says so.

  No behaviour changes. `runToA2ATask` has always bound `contextId` to
  `project_id` and `a2aMessageToCreateRun` has always read it back as
  `projectId`; `ThreadId` appears nowhere in the A2A bridge. What changes is that
  the binding is asserted in both directions, and the documentation stops
  claiming the opposite.

  `docs/sdk/sessions/a2a-threading.md` opened with "A2A connections attach at the
  Thread level, not the Project level" and presented that as the reason the Thread
  layer is first-class — the single load-bearing justification for a whole
  hierarchy level. The code never did it. The claim survived because nothing
  asserted the actual binding: a doc page and a set of comments agreed with each
  other while the code disagreed with both.

  The page now states what the bridge does, retracts what it used to say, and
  carries the replacement table for the Thread removal that follows. A test pins
  the binding in both directions so the next version of this cannot drift back
  into prose.

## 12.2.0

### Minor Changes

- a7ac587: An approver sees which agent, on both approval surfaces, and is never shown a step that cannot run.

  **There are two approval surfaces, and the previous release fixed one of them.**
  `PlanStep.agentId` was added so an approver could see WHICH agent a step goes to
  rather than only THAT it delegates. It reached `PlanApprovalRequest` — the shape
  a host sees when it installs its own handler on `PlanManager` — and stopped
  there. `PlanApprovalData`, which is what every `resumeHandler` host receives,
  declares its own step shape, and both mappers that build it copy field by field.
  So the busier surface kept showing `toolName: 'create_task'` and nothing else:
  exactly the behaviour that change set out to end.

  `PlanApprovalData.steps[]` now carries `agentId`, populated in both mappers.

  **A plan may no longer name an agent the run cannot launch.** `create_task`
  constrains `agent_id` with a closed enum while `approve_plan` typed the same
  field as a bare string, so a model could propose — and, now that the name is
  visible, a human could approve — "delegate to X" for an X that `create_task`
  rejects at schema-parse time. `approve_plan` now refuses such a plan.

  The check is in `execute`, not in the schema, and both halves of that are
  deliberate:

  - **Not the schema.** `approve_plan` is mounted even with an empty roster,
    because planning with no delegates and a human channel is a supported
    configuration, and `z.enum([])` renders as `{"not":{}}` — the shape
    `delegateSchema` already refuses, because a strict tool-schema validator
    rejects the whole request over it rather than the one tool. `create_task`
    escapes that by being withheld entirely; this tool cannot be.
  - **In `execute`, before `startGenerating`.** So the refusal leaves no
    half-built plan behind, and the human is never shown the bad step at all. The
    message names the roster, so the model corrects itself in one turn.

  Enforcing in `execute` as well as the schema is the precedent the canonical
  `Agent` tool set for complete mediation.

## 12.1.0

### Minor Changes

- be3f345: A fan-out naming the same agent runs every child instead of one.

  `AgentRegistry` hands out ONE `typedAgent` per registered id, and an agent
  instance refuses a second concurrent `run` — correctly, because its abort
  controller and run id are instance state and two overlapping runs would cancel
  each other. So four `create_task` calls naming the same `agent_id` drove four
  runs at one shell: one produced a result and three died with
  `ConcurrentInvocationError`, while `create_task`'s own description tells a model
  that exactly this fan-out is the thing to do.

  The remedy was already written down — "a host that wants parallelism constructs
  a second instance" — and was unreachable from delegation, where the definition
  owns the instance and the caller has only an id.

  `Agent` gains an optional `forRun()`, implemented by `AbstractAgent`, returning
  a fresh shell of the same class built from the same metadata. `AgentManager`
  takes one per spawn. Nothing else about a child was ever shared: its abort
  signal is the task's own, its config is rebuilt per spawn by `configBuilder`,
  and the manager cancels through the task rather than the agent. The shell was
  the last shared thing.

  `AgentDefinition` also gains `createAgent?`, which wins over `forRun` — for an
  agent that needs real construction arguments, which a metadata-only rebuild
  cannot supply. Most hosts need nothing: agents built on `AbstractAgent` already
  work.

  The lock is unchanged and still refuses. That refusal is right for a host
  calling `run` twice on one instance on purpose; what changed is that delegation
  no longer does so by accident. Loosening the lock instead would have been the
  smaller diff and the wrong one — the state it guards is genuinely instance
  state, and serialising same-agent spawns behind it would deadlock a child that
  spawns a grandchild of its own id.

  Its message now names the remedy rather than only the refusal.

  Found by running a four-way fan-out against the published package, not by a
  test.

## 12.0.1

### Patch Changes

- 5fe072b: A concurrent fan-out no longer kills most of its own launches.

  `LocalTaskGateway.createTask` passes a progress tee into `sendMessage`, and that
  callback read `task.taskId` — the `const` that the very same `await` assigns. So
  a child that emitted any run event before `sendMessage` resolved reached that
  line inside the temporal dead zone and threw `Cannot access 'task' before
initialization`, taking the whole launch down with it.

  Two things kept it hidden. A single sequential launch usually resolves before
  the child says anything, so the ordering rarely bit. And the throw only happens
  when a progress listener is actually attached — with an empty subscriber set the
  loop body never runs and the dead zone is never entered, which is why no unit
  test caught it. `create_task` attaches one for its idle bound on every blocking
  launch, so production always had one.

  Under a concurrent fan-out both conditions hold. Observed on the published
  package: four `create_task` calls from one assistant turn — the shape that
  tool's own description tells the model to use — and three of the four died with
  `create_task failed: Cannot access 'task' before initialization`.

  The tee now reads an id filled in after the spawn resolves, and reports nothing
  before then. That window is not a loss: with no id the caller does not yet hold
  the handle, so no idle bound is running against the task and there is no
  progress to attribute to anyone.

  Introduced in #130 with the idle-bound work. Found by running a live concurrent
  fan-out against the published package rather than by any test.

## 12.0.0

### Major Changes

- d126799: A plan that settles says so on the run stream, and the host callback can be heard.

  The plan events stopped one short of the outcome. `plan_ready`, `plan_approved`,
  `plan_rejected` and `plan_step_updated` all reached the wire; `plan.completed`
  and `plan.failed` were folded into a bare `break` in the translator and emitted
  nothing. So a host watching the stream saw the steps report and then silence —
  it could learn a plan had been approved and never that it closed, which leaves a
  plan rendered as in-flight indefinitely.

  `RunEvent` gains `plan_completed` and `plan_failed`, and `StreamEventType` gains
  `plan.completed` and `plan.failed` for the SSE bridge.

  **`failPlan` stops discarding its argument.** The parameter was spelled `_error`
  because nothing read it, so a failed plan carried no account of what went wrong
  — and an event that says "failed" without saying why puts the reader back where
  the missing event did. `Plan` gains `failureReason`, and `plan_failed` carries
  it.

  **`onContextCreated` now fires where it can be heard.** It ran before the event
  translator was wired, so a host that built its plan in that callback — which is
  what the callback is for — did it into silence: `plan_ready`, `plan_approved`
  and every `plan_step_updated` from inside it were emitted with nothing
  subscribed. It now runs after the wiring _and_ after `runMgr.init()`; moving it
  only as far as the wiring traded a silent drop for a store that was not yet
  initialised. It is still called before the iteration loop, which is the
  guarantee the callback actually makes.

  **How this was found is the part worth repeating.** It came out of the first
  live end-to-end run, not from a test. The settlement tests read the outcome off
  `PlanManager` through `onContextCreated`, so they proved the plan settled
  without ever asking whether a consumer of the event stream could see it — a
  verification that was entirely sound about something other than what needed
  knowing.

  **Breaking:** `RunEvent` and `StreamEventType` are wider. A consumer that
  switches exhaustively over either — which the SDK's own A2A mapper, SSE mapper
  and run reporter all do, and which is why the compiler named all three — needs
  arms for the new members.

## 11.0.0

### Major Changes

- 82267e1: `agent_task_list` and `wait_for_task` are scoped to the run that launched the task.

  A supervisor could read a sibling run's worker output by listing.
  `SupervisorAgentConfig.gateway` exists so a host can hand the SAME gateway to
  several runs, which makes `TaskGateway.listTasks()` gateway-wide by design —
  and `agent_task_list` handed that straight to the model, including each task's
  `result`, the worker's actual output. `wait_for_task` had the same reach through
  `getTask`.

  `CompletionInbox` closed exactly this on the push side, because
  `onTaskCompleted` is a broadcast and a shared gateway would otherwise hand each
  supervisor the other's completions. The pull side kept no such record and asked
  the gateway directly, so the same leak stayed open through a different door.

  The scope lives in the coordinator tools rather than in `listTasks()`, because
  the two answer different questions. A host calling `listTasks()` is the operator
  and may legitimately want everything on its gateway; a model calling
  `agent_task_list` is one run asking about its own work. Narrowing the gateway
  method would take the operator's view away in order to fix the model's.

  `wait_for_task` gives the same answer for a sibling's task as for one that never
  existed. Distinguishing them would confirm a task id to a run that was not
  supposed to know it — the leak in miniature.

  **Breaking, for a host that shares one gateway across runs.** A run now sees
  only the tasks it launched through its own `create_task`. If you relied on one
  run listing another's tasks, that path is closed; use `TaskGateway.listTasks()`
  from the host, which is unchanged and still gateway-wide.

  **Also breaking in a narrower way:** a task launched through a DIFFERENT surface
  on the same gateway — `buildAgentTool`, or the host directly — is not listed by
  these tools. That is the same rule rather than an exception to it, but it is a
  behaviour change if you mixed surfaces on one gateway and listed through the
  coordinator.

- 368fa4b: A plan step reports its own outcome, so a plan that succeeded can say so.

  A plan's steps had no relationship to the work that carried them out.
  `approve_plan` built steps, `create_task` launched workers, and nothing
  connected the two — so no step could ever be observed, `updateStepStatus` had no
  production caller anywhere, and a plan could reach `failed` (the error path
  calls `failPlan`) or sit at `executing` forever, but never `completed`. A host
  reading `plan.status` after a fully successful run was told the work was still
  going.

  **Two bindings, because there are two kinds of step.**

  - A **delegated** step reports through the launch that carries it out:
    `create_task` gains `plan_step_id`. The step goes `running` when the worker
    starts and `completed` or `failed` when it settles — from the same
    two-authority check the tool result uses, so a worker that returned
    `status: 'failed'` under a gateway state of `completed` fails its step.
  - An **orchestrator-owned** step — one with no `agent_id` — has no tool call to
    bind to at all. The new `update_plan_step` tool is how it reports, and without
    it a plan containing one could never settle however well it went. `skipped` is
    a first-class outcome there: a plan that turned out not to need a step went
    right, and forcing that into `completed` or `failed` would make the plan lie
    in one direction or the other.

  **`approve_plan` now tells the model the step ids**, in its output and in
  `data.steps`. Both bindings name ids, and a binding whose caller has never been
  told the ids is a binding that does not exist.

  **The run settles the plan on success**, but only when every step has reported.
  The check is a read — the new `PlanManager.unreportedSteps` — rather than a
  caught throw: `completePlan` refuses an unreported step on purpose, and letting
  that throw at the end of a successful run would turn a run that worked into a
  run that crashed on its way out. A plan with silent steps is left `executing`,
  which is the honest answer.

  **Breaking:** `update_plan_step` is a new name in the coordinator tool set, so a
  host that registers its own tool under that name will now get
  `ToolNameCollisionError` at run start. `approve_plan`'s approved output is no
  longer byte-identical — it opens with the same sentence and continues with the
  step roster; the historical text is still the prefix, and `data.steps` is there
  so a host need not parse prose.

## 10.0.0

### Major Changes

- 84660f7: `drainQuery` no longer accepts `launchedTasks`, a map nothing ever read.

  `SupervisorAgent` created a `Map<TaskId, LaunchedTaskMeta>`, filled it from
  `onTaskLaunched`, and threaded it through `drainQuery` into the iteration
  context. Nothing consulted it — six mentions across the repository, every one a
  declaration, an assignment, or a hand-off, and no reader at any of them. It is
  what remains of the old non-blocking delegation flow, whose consumer was removed
  when `create_task` became blocking.

  For a host the field was inert in both directions: nothing writes a
  host-supplied map, so passing one did nothing and reading it back gave an empty
  map. Removed straight out rather than deprecated, on the rule that a deprecation
  window exists so working code can migrate and there is no working code to
  migrate off a field with no producer and no reader.

  **What stays.** `onTaskLaunched` on the coordinator tool options, and the meta it
  carries. The `Agent` tool still calls it, so it remains a real seam for a host
  that builds coordinator tools directly and wants to observe launches. What went
  was the accumulator, not the signal.

  **Breaking:** `launchedTasks` is gone from `drainQuery`'s parameters, and
  `LaunchedTaskMeta` is no longer exported from the iteration context module. If
  you passed either, delete the argument — it was not doing anything. To observe
  launches, pass `onTaskLaunched` to `buildCoordinatorTools`.

## 9.0.0

### Major Changes

- 16dc634: A failed worker is reported as a failure, and a plan task can say it failed.

  **`create_task` reported a failed worker as a success.** Two layers can disagree
  about whether a delegated run succeeded: the gateway's `TaskHandle.state`, and
  the run's own `BaseAgentResult.status`. The kernel's `finalizeChild` always calls
  `markCompleted`, so `state === 'completed'` holds for a child that ran and
  returned `status: 'failed'` — and `create_task` asked only that layer. The model
  received the failure text as an answer, the tool result carried
  `isError: false`, and the plan task was written closed as though the work had
  been done.

  The correct two-authority predicate was already written, twenty lines away, in
  the canonical `Agent` tool — put there because a review caught it on that site,
  and nothing carried the answer to the other one. It now lives in one place both
  reach.

  **`TaskStatus` gains `failed`, and that is the breaking part.** A unit that did
  not succeed had nowhere to say so, which is why a failed delegation was recorded
  as `completed` with the failure encoded as prose in `description`: a reader
  scanning statuses saw work that had been done, and a dependent unit had no way
  to tell at all.

  If you switch exhaustively over `TaskStatus`, or hold a `Record<TaskStatus, T>`,
  you need a `failed` arm. `isTerminalTaskStatus` now returns `true` for it —
  terminal means "will not change on its own", not "succeeded", and a unit blocked
  on something that failed would otherwise wait forever for a status that will
  never arrive. In the store's transition ranking `failed` sits alongside
  `completed` rather than after it, so `in_progress → failed` is allowed and
  `completed → failed` is not.

  **Two smaller repairs ride along.** A background launch refused for want of a
  completion inbox now marks its plan task failed rather than leaving it in
  progress with no worker behind it — nothing later closes a task whose launch
  never happened. And the `Agent` tool passes `parentSpan` when creating its
  child, so a delegated run joins the turn that asked for it instead of starting
  its own root trace; `create_task` has done this all along.

- a743c7e: A delegated run is built with the config its caller asked for, and a supervisor can select its sibling-failure policy.

  Two capabilities were declared, documented, typed, and unreachable. Both are the
  same defect: a knob wired to nothing, which reads to a caller as a knob that
  works.

  **`CreateTaskOptions.configOverrides` was accepted and dropped.**
  `LocalTaskGateway.createTask` built its own `configOverrides` object out of
  `parentSpan` alone and never read the field, so a caller pinning a delegated run
  to a cheaper model, or capping its iterations, got the agent's defaults and no
  indication anything had been ignored. It is forwarded now. A caller who sets
  both the field and the dedicated `parentSpan` option gets the dedicated one for
  the span — that is the specific field for the job — and keeps every other
  override alongside it.

  **`siblingFailurePolicy` could not be selected by any host.**
  `LocalTaskGateway` has honoured it since it was written and the cancellation
  machinery behind `'cancel-siblings'` is complete — but it was the fifth
  constructor argument of a gateway `SupervisorAgent` builds itself, and the
  supervisor passed four. Every host in existence ran `'continue'`, and the only
  route to the other value was to construct the gateway by hand and pass it as
  `config.gateway`. It is now `SupervisorAgentConfig.siblingFailurePolicy`.

  `'continue'` remains the default and deliberately so: partial results are
  usually worth having, and tearing down healthy siblings on any failure lets one
  flaky child waste four good ones. `'cancel-siblings'` is for a fan-out whose
  parts only mean something together. The choice is now expressible; the answer
  has not changed. The field is ignored when the host supplies its own `gateway`,
  which owns its policy.

  **Breaking:** `CreateTaskOptions.configOverrides` is now typed
  `Partial<BaseAgentConfig>` instead of `Record<string, unknown>`. It lands on
  `SendMessageOptions.configOverrides`, which is already that shape, and the loose
  type let a misspelled key type-check and then silently do nothing — the same
  silence the field was already producing. If you pass a key that is not on
  `BaseAgentConfig`, it will now fail to compile; that key was never being applied.

  **Also:** the two-authority failure check in `LocalTaskGateway` moves to
  `taskFailed` in `tools/coordinator/outcome.ts`, next to `taskSucceeded`. It is
  deliberately _not_ the negation of that predicate — a task that is still running
  satisfies neither, and cancelling a fan-out on `!taskSucceeded` would tear down
  siblings the moment the first child had merely not finished yet. The gateway's
  copy was correct; a rule each caller has to remember is one a caller eventually
  forgets, which is what happened to `taskSucceeded` before it was consolidated.

- 529b343: `PlanManager.completePlan` refuses an unreported step instead of scoring it a failure.

  **A plan that fully succeeded was reported as failed.** `completePlan` asked one
  question — "is every step `completed` or `skipped`?" — and everything that was
  not fell to the same branch. A step still `pending` therefore produced
  `status: 'failed'`, indistinguishable from a step that genuinely failed. Since
  `addStep` defaults every step to `pending`, a host that added steps, did the
  work, and settled the plan without calling `updateStepStatus` on each one got
  `failed` for a plan where nothing had gone wrong. That is the path of least
  effort through this API, not an unusual one.

  The two cases are different facts and deserve different answers. A step that
  FAILED is an outcome: report the plan failed. A step nobody reported on is not
  an outcome at all — it says the caller and the plan disagree about whether the
  work is over, and answering `failed` settles that disagreement by inventing a
  result.

  **What changes for you.** `completePlan()` now throws when any step is still
  `pending` or `running`. The message names the unfinished steps and both ways
  forward, because a caller in this position either forgot to report progress or
  called too early, and only they know which:

  - report each step with `updateStepStatus` — `'skipped'` is a valid outcome for
    work that was planned and then not needed; or
  - call `failPlan` if the plan is being abandoned, which marks unfinished steps
    `skipped` and settles the plan as failed.

  Behaviour is unchanged once every step has reported: all `completed` or
  `skipped` still yields `completed`, and any `failed` still yields `failed`.
  No code in this repository called `completePlan`, so nothing inside the kernel
  changes behaviour; the affected callers are hosts.

  **`PlanManager` now says which half of it the kernel drives.** The kernel builds
  a plan, gates it, translates its events, and settles it on failure — it never
  reports a step outcome and never settles a plan that succeeded. That is a
  deliberate split, since `drainQuery` hands the manager to the host through
  `onContextCreated` for exactly this purpose, and a search for callers inside the
  package finds none because the callers are outside it. The absence had already
  been read once as a dead layer and proposed for deletion; what that would have
  deleted is a working human-in-the-loop approval gate. It is written down now.

### Minor Changes

- e355049: The plan a human approves names the agent the model chose.

  `approve_plan` asks the model for an `agent_id` per step — "which agent handles
  this" — and reduced the answer to a boolean. The step got
  `toolName: 'create_task'` when any agent was named and nothing when not, so the
  name was dropped between the model saying it and the human being shown the plan.

  The approval is the one moment where that difference can still be acted on.
  Approving "delegate this step" is not the same as approving "delegate this step
  to the agent with shell access", and a reviewer who cannot see which agent was
  chosen cannot withhold approval from the wrong one. Two delegated steps reached
  the approver identical in every field.

  `PlanStep` gains `agentId?: string`, populated by `approve_plan` from the
  model's choice. A host rendering a plan approval can show it directly. Absent
  still means the step is the orchestrator's own work, which is what omitting
  `agent_id` says — so absent stays absent rather than becoming a placeholder.

  Typed rather than folded into the existing `estimatedInput`, which is `unknown`:
  an approval gate's whole job is being readable, and a field a host must cast
  before it can render is one a host renders wrong or not at all. `estimatedInput`
  is now documented as having no producer and no reader, since that is what it
  has, and it is left in place because it is on the published typings.

- 16dc634: A host can see the fan-out gate, and the plan graph the model is already keeping.

  **`SupervisorAgentConfig` gains `maxToolConcurrency`.** The kernel has honoured
  it all along and `ReactiveAgent` forwards it — it was missing on the one agent
  whose entire job is delegation. So the agent that fans out could not set the gate
  that bounds a fan-out, while the agent that does not fan out could, and a host
  wanting a narrower one had to reach past the supervisor to `drainQuery`.

  Note what it bounds: how many delegated children run **concurrently**, not how
  many a turn may launch. A model emitting twenty `create_task` blocks still
  launches twenty; they queue.

  **`task_created` and `task_updated` carry `blockedBy`.** The task store
  maintains a full dependency graph — `blocks` and `blockedBy` mirrored on both
  ends, written under a lock, deadlock-avoided — and none of it reached the wire.
  A host could draw a flat list of units and nothing about their order, while the
  model was already maintaining the order.

  Absent rather than empty when a unit depends on nothing, so a reader can tell
  "no dependencies" from an emitter that predates the field.

  **And `block()` announced nothing at all.** Both stores wrote the edge and
  emitted no event, so the graph was observable only by polling: a listener saw a
  unit created and never learned that something now waits on it. Both stores now
  announce **both ends**, because both changed — a host tracking one side would
  draw half the edge. The disk store announces only when something actually
  changed, so re-establishing an existing edge stays silent.

  That second half is the one worth knowing about if you consume these events: the
  field alone would have been useless, because the moment a dependency is created
  was never on the wire in the first place.

### Patch Changes

- 16dc634: A concurrent fan-out no longer allocates more budget than the parent has.

  `sendMessage` read the parent's remaining budget at the top and debited it after
  `provisionSpawn` — putting the two halves of a read-modify-write on either side
  of an await, with the only critical section in between. So siblings launched
  from one assistant turn all read the same undebited number and each took a
  fraction of it. Measured: \*\*four concurrent children were handed 50 000 + 50 000

  - 50 000 + 50 000 from a pool of 100 000.\*\*

  `create_task`'s own description instructs exactly the shape that triggers it —
  _"'fan out 8 specialists' is one assistant message with 8 create_task blocks"_ —
  so the documented usage was the reproduction.

  The read, the refusal when an allocation floors to zero, and the debit now all
  happen inside the per-parent spawn lock. That keeps the property the debit's
  placement was chosen for — a spawn this call rejects burns no allocation — while
  closing the race that placement opened. It was introduced by a correct fix to a
  different bug: moving the debit after the provisioning put it outside the lock.

  **Nothing pinned it**, and the reason is worth knowing if you write tests here:
  the existing concurrency test builds a fresh context per call, so each spawn got
  its own tracker — it measures width, not budget. The sequential tests pass
  because a refund makes the arithmetic close. The regression test holds its
  children open, because a settled child refunds and the refund restores a
  plausible number; a test that measures after settle sees a healthy total and
  reports nothing.

## 8.0.0

### Major Changes

- 9ac8dd4: A delegate's output is framed as untrusted material on every path the model reads it, and it can no longer end the frame early

  Blocking `create_task` and `wait_for_task` wrap a worker's text in the
  `<namzu-untrusted>` envelope. Two other paths carried the same bytes and did
  not: the completion notification injected into the transcript, and
  `agent_task_list`'s rendered output. So whether a worker's words arrived as
  material or as the parent's own reasoning depended on how the model happened to
  fetch them — and the two unframed paths are the ones reached when a wait was
  abandoned, which is when a run is already off its expected course.

  Worse, the notification's own delimiter was forgeable. Measured: worker output
  containing `</task-notification>` produced two closing tags in one message, with
  attacker-controlled text sitting outside the first — reading as ordinary
  transcript rather than as a delegate's material.

  **What changed on the wire the model sees.**

  - The notification now nests a `<namzu-untrusted kind="agent-result">` block
    inside `<task-notification>`. Kernel metadata (`task_id`, `agent`, `state`,
    `duration_ms`) stays OUTSIDE it — framing this kernel's own statements as
    untrusted would tell the model to discount the only part of the message it
    can rely on — and so does the truncation notice, which is an instruction
    about how to fetch the rest.
  - `agent_task_list` wraps each finished task's output the same way, with the
    same `agent` and `task` attributes the blocking path uses.
  - Both delimiters are defanged inside worker text, case-insensitively. The
    replacements (`task_notification`, `namzu_untrusted`) share no substring with
    the tokens they replace — a replacement that still contains the token is found
    again by a second pass or by any looser matcher downstream.
  - A notification is 257 characters longer than before — measured, both for a
    five-character result and for a truncated 4 kB one, so the cost is fixed
    rather than proportional to the output. It grows only with the length of the
    agent id and task id, which appear in the envelope's attributes.

  `data.result` on both tools is unchanged, so a host reading results
  programmatically is unaffected. If you match on the model-facing text of either
  tool, expect the envelope.

- 9ac8dd4: A completion inbox hears only about the tasks its own run launched, and a supervisor releases the gateway it borrowed

  `TaskGateway.onTaskCompleted` is a broadcast and `TaskHandle` carries no run id,
  so every inbox attached to a gateway was handed every completion on it.
  Measured: two inboxes on one gateway, one run launches a task, and the OTHER
  run drains it — it would have been told "a task you launched has finished", a
  false statement, over another run's worker output. A shared gateway is not an
  abuse of the API: `SupervisorAgentConfig.gateway` takes one, and a host that
  owns a gateway reuses it.

  Separately, nothing ever called `CompletionInbox.close()`. Three sequential
  `SupervisorAgent` runs against one host gateway left three live subscriptions,
  each still holding its run's handles, and the set only grew.

  **Breaking, and what to do.**

  - `CompletionInbox` now ignores a completion for a task it was not told about.
    If you drive `buildCoordinatorTools` there is nothing to do — `create_task`
    declares every launch, blocking and background alike. If you launch tasks
    some other way and expect notifications, call `inbox.launched(taskId)` after
    the launch. `inbox.expect(taskId)` already implies it.
  - `SupervisorAgent` closes the inbox it created when the run ends, including
    when setup throws. An inbox you construct yourself is still yours to close.
  - `close()` now clears what the inbox owned and claimed as well as what it
    queued, so a closed inbox cannot be re-armed through a stale reference.

  The ordering that would otherwise turn this into lost results is handled in
  two layers. `gateway.createTask` resolves one microtask before its caller can
  say who owns the task, so a worker that finishes inside that window is
  announced first. An unowned announcement is therefore BUFFERED rather than
  dropped, and ownership may be claimed retroactively; the buffer is bounded at
  32 entries so that on a shared gateway it cannot accumulate every other run's
  worker output, and an eviction is logged at WARN so a dropped completion is
  never inferable only from an absence. Where the buffer could not hold an entry,
  `launched()` also asks `gateway.getTask` — an assumption that a just-settled
  task is still findable, now stated on `TaskGateway.getTask` itself so a host
  that cannot meet it knows it is the one paying.

- 9ac8dd4: `create_task` offers `background: true` only when there is somewhere for the result to arrive

  A background launch returns a task id and tells the model its result will come
  "later, as a task notification". The `CompletionInbox` is the only thing that
  delivers one — it holds the run open for the outstanding worker and puts the
  completion into the transcript. `buildCoordinatorTools` mounted the parameter
  whether or not it was given an inbox, so a host without one had a tool
  advertising a channel that did not exist. Nothing failed loudly, because the
  launch itself succeeded; the result simply never arrived.

  Without a `completionInbox`, `create_task` no longer declares `background` and
  its description no longer mentions it. Everything else is unchanged: the
  blocking path, `wait_for_task`, `cancel_task` and `agent_task_list` are all
  still mounted. Pass a `completionInbox` — to `buildCoordinatorTools` **and** to
  `drainQuery` — to get background launching back. `SupervisorAgent` does both
  already, so a host using it sees no change.

  A `background: true` that reaches `execute` some other way — a directly
  constructed definition — is REFUSED, naming the missing piece, rather than
  quietly turned into a blocking call: the caller asked for something that
  returns immediately, and giving them a different thing is accepting work whose
  stated terms cannot be met. The abandoned-wait messages on `create_task` and
  `wait_for_task` no longer promise a notification either, and
  `agent_task_list` stops telling the model to avoid the listing when the
  listing is the only route left.

  The parameter is withheld rather than refused per call, and rather than thrown
  at construction. A parameter the model is never shown costs nothing; one it is shown and then
  denied costs prompt-prefix tokens plus an iteration per attempt. And a throw
  would break a caller doing something legitimate — an inbox-less coordinator
  surface is a supported configuration. This is the same reasoning that made an
  empty roster withhold `create_task` rather than refuse to build.

### Minor Changes

- a39c2ed: A compaction pass now reports both of its outcomes.

  Two gaps, in opposite directions, in the same function.

  **A compaction that sheds nothing was invisible to everyone.** All three decline
  paths — the reducer throws, it returns no fewer messages than it was given, or
  its result splits a `tool_use` from its `tool_result` and is refused wholesale —
  reached a log line and stopped there. A host that silences its logger, which
  every command-line entry point does, made a failed compaction invisible to the
  user, to the host _and_ to the model at once. The run then continued at full
  context toward a provider rejection several turns later that named none of this.
  A shed that did not happen is exactly as consequential as one that did, and only
  one of them was on the wire.

  New `compaction_failed` event (wire: `compaction.failed`) carrying `cause`
  (`reducer_threw` | `shed_nothing` | `split_tool_pair`), the unchanged message
  count, and the reducer's error where there was one. The cause is on the event
  because the three want different responses: one may succeed next pass, one will
  decline identically every time, and one is a reducer bug that `findSafeTrimIndex`
  exists to prevent.

  **And a compaction that succeeded was invisible on the path most hosts take.**
  `compaction_completed` was emitted only from the structured working-state path.
  The reducer path — taken by any host-supplied `contextReducer` and by
  `strategy: 'sliding-window'` — emitted nothing at all, so the event whose own
  documentation says it exists because "a host could not show the user that context
  was dropped" never reached the hosts most likely to need it. It is emitted from
  both paths now.

  That second one was found by a test written for the first: asserting that a
  successful compaction does _not_ report a failure is what showed it reported
  nothing.

  **If you switch exhaustively over `RunEvent`, you need a case for
  `compaction_failed`.** Nothing else changes: no existing event's shape moved, and
  a host that ignores unknown events is unaffected. The A2A bridge deliberately
  does not forward either compaction event — a peer models a task lifecycle and
  cannot act on how this runtime manages its own context.

- f6e0594: `token_usage_updated` now carries the current context size and the window it is measured against.

  A host built a context indicator, and it could not have been right. The event
  carried `usage` — **cumulative run spend**, summed over every turn, monotonically
  increasing and untouched by compaction — and nothing about the size of the
  conversation being sent. So the host divided cumulative spend by a context
  window guessed from a substring of the model name, and rendered the result as an
  unqualified percentage, continuously.

  Both terms were wrong, and the numerator was the worse of the two. A guessed
  window is wrong by a bounded factor. Cumulative spend has three properties that
  make it not merely imprecise but actively misleading:

  - It **never decreases**, by explicit design — the accumulator is documented as
    monotone so it can never under-report a bill. Compaction does not reduce it.
  - It grows **superlinearly in turn count**, because every turn re-sends the whole
    history and counts those prompt tokens again. Ten turns over a 50k context
    accumulate roughly 500k.
  - It measures **spend**, which is the right quantity for cost and the wrong one
    for occupancy.

  So an indicator built on it saturates at full long before the context is, and it
  is **anti-correlated with what it claims in exactly the regime a user cares
  about**: a long conversation reads FULL while the real context may be a fifth of
  the window. That alarms people into compacting or restarting when they have
  room — worse than showing nothing, because silence does not tell you something
  false in red. In the other direction, a driver that reports no usage shows 0%
  for a conversation that is really there.

  The kernel already computed the right numbers on every iteration and kept them
  to itself. `measureContext()` is now exported, and the event carries four new
  optional fields: `contextTokens`, `contextMeasuredBy` (`'provider' | 'estimate'`),
  `contextWindowTokens` and `windowSource` (`'config' | 'model-table' | 'default'`).
  They are named apart from the cumulative figures beside them deliberately —
  reaching for the wrong one should be a visible mistake, not a plausible guess.

  **They are absent when the run has no compaction configuration**, because nothing
  then resolves a window and inventing one would be the guess this replaces. A
  surface should show what it can name rather than a fraction it cannot ground.

  **A fraction is only as honest as the weaker of its terms.** `contextMeasuredBy`
  and `windowSource` exist so a surface can pass that on rather than presenting an
  estimate as a measurement. Nothing existing changes: `usage` and `cost` are
  untouched, and the new fields are additive and optional.

- a39c2ed: A verification rule can name one tool and one argument.

  Every pattern rule an operator could write was one of two wrong things.

  `custom_pattern` carries no tool scope, so a rule written about `bash` decided
  `edit` calls as well — `target: 'both'` prefixes the tool name to the subject
  rather than requiring it, which is not a scope. And `target: 'args'` tests
  `JSON.stringify(toolInput)`, so the subject is the JSON _text_ of the whole
  argument object: the natural, anchored thing to write, `^git push`, is tested
  against `{"command":"git push origin main"}` and can never match. The rule then
  decides nothing, silently. Pinning the tool cost the anchor; anchoring cost the
  tool scope.

  New `argument_pattern` rule — `toolNames`, `argument`, `pattern`, `decision` —
  whose subject is the named argument's own value, so an anchored pattern means
  what it looks like it means. The refusal names the argument as well as the
  pattern, which is what tells a model whether a different value could get through.

  It deliberately decides nothing in three cases: the tool was not called, the
  argument is absent, or the argument holds an object or an array. No string a
  pattern could match says anything true about a structured value, and serialising
  one to try would put this rule back where `custom_pattern` already is. To refuse
  a tool over the _shape_ of its input, deny it by name. Numbers and booleans are
  matched rather than skipped — they render unambiguously, and a rule about a
  numeric argument is a reasonable thing to write.

  `custom_pattern` is unchanged and not deprecated: matching anywhere in the
  serialised input without caring where is a real use, and it is now documented as
  being that rather than reading as something it never was. The trap was the name,
  not the behaviour.

- 9ac8dd4: A run that ends any way other than a plain final answer no longer throws away a finished worker's output

  The iteration loop consulted its completion inbox at exactly one place: the
  branch where the model stops calling tools and answers. It leaves by eight other
  routes, and three of them are ordinary ways for a run to END — a tool the author
  marked `terminal`, a captured `structured_output`, and the host's `stopWhen`.
  A background or abandoned worker that finished while any of those was deciding
  had its result dropped: the gateway held it, the run closed, nothing read it.
  Measured before the fix — terminal-tool exit and `stopWhen` exit both delivered
  nothing; the final-answer exit delivered in 44 ms.

  Delivery now happens in a `finally` around the loop, so it does not depend on
  each exit remembering — including the two `return`s and a generator abandoned by
  its consumer, which no post-loop statement reaches.

  **What you may observe.** On those exits `Run.messages` can now end with a
  `task-notification` user message after the assistant's last message. The answer
  is on `Run.result`, as before. If you were reading the answer off the last
  element of `Run.messages`, that assumption was already unsafe whenever a
  notification landed mid-run; it is now unsafe in three more places.

  **Which exits wait, and which only deliver.** A hold buys the model a turn in
  which to use a result, so it is only worth paying where a turn can still
  happen. A terminal tool and a captured `structured_output` have decided the
  answer, so those deliver what arrived and stop. `stopWhen` is a programmable
  halt that says nothing about whether the answer is complete, so it now HOLDS
  like the ordinary final-answer exit — a precedence rule chosen here, not
  something `stopWhen` implies — and costs exactly one extra turn, after which
  the predicate fires again with nothing pending.

  The stop reason survives that extra turn. `stopWhen` is consulted only after a
  tool batch, so when the extra turn is prose the predicate is never asked again
  and the run leaves by the ordinary route — which would have reported
  `stopReason: 'end_turn'`, naming the shape of the last message rather than the
  host's decision. A run that ends because a host said stop now reports
  `'stop_condition'` whether or not a delegated result delayed it by a turn. If
  the extra turn instead runs more tools, the predicate is asked again and
  answers for itself.

  A run that ends with a worker still running now says so on
  `Run.abandonedTaskIds` rather than leaving the impression the result arrived.

- 9ac8dd4: A run that ends over a still-running worker says so, and the untrusted envelope's own label can no longer close it

  Three things an adversarial review of the completion path found.

  **`Run.abandonedTaskIds`.** A run can settle while a worker it launched is
  still going — the model answered, a terminal tool decided the result, a
  `stopWhen` fired. Until now nothing said so, which left the impression the
  worker's result had been delivered. The run now names those task ids.

  They are **named, not cancelled**, and that is the decision: giving up on a
  wait is a statement about the waiter, not about the work — the rule this
  subsystem already applies to `wait_for_task` — and "the parent answered early"
  is a weaker warrant for killing a child than "the clock ran out", not a
  stronger one. A worker mid-write is not the kernel's to judge. A host that
  wants the work stopped has `cancel_task` and the run's abort controller, and
  now has the ids to use them on.

  **`wrapUntrusted` neutralises its own delimiter inside `provenance`.** The body
  was defanged and the attributes escaped; the provenance line was interpolated
  raw, and every caller in the SDK builds it from a value it did not author — an
  agent id from a roster, a server name from a connector manifest. A provenance
  carrying `</namzu-untrusted>` ended the block before the content it was
  introducing. This affects the blocking `create_task`, `wait_for_task` and the
  `Agent` tool as well as the two paths framed in this release.

  **`background: true` with no inbox is refused, not silently made blocking**,
  and the sentences match. The abandoned-wait messages on `create_task` and
  `wait_for_task` promised "its result will arrive separately as a task
  notification" unconditionally — false with no inbox, and a model told to expect
  a message waits for it. They now say where the result actually is. The
  `agent_task_list` description likewise stops telling the model not to use the
  listing when, without an inbox, the listing is the only route left to an
  abandoned launch's output.

  `CompletionInbox` gains `outstandingTaskIds`, which reads the ids and cancels
  nothing.

- 9ac8dd4: A run holding for a background worker waits a share of its own budget, not a fixed two minutes

  `BACKGROUND_TASK_GRACE_MS = 120_000` was unrelated to the run it bounded, and
  wrong in both directions at once. Measured: a run configured `timeoutMs: 20_000`
  was held open for **120,267 ms** — six times its own budget — because the hold
  sits inside an iteration and the run guard only checks between them, so nothing
  could interrupt it. In the other direction, on a run with hours left the same
  two minutes abandoned delegated workers observed at 4m21s, 5m58s and 8m04s, all
  comfortably inside the hour `DELEGATION_TIMEOUT_MS` already declares.

  The hold is now `min(remainingBeforeFinalize × 0.5, DELEGATION_TIMEOUT_MS)`,
  where `remainingBeforeFinalize` is the time left before the run guard stops
  asking for more work and asks for a closing summary (90% of `timeoutMs`), less
  what the run has spent — carried across a resume, so a checkpointed run sizes
  the hold from what is left of the RUN rather than of the process now hosting
  it, and read when the wait starts rather than at the top of the iteration.

  - **Half, not all.** The hold exists to put a worker's result where the model
    can read it, and reading it costs a turn. Spending everything remaining would
    deliver a notification into a run with no turn left to act on it — the same
    failure the mechanism exists to prevent.
  - **Bounded against the boundary that binds.** Measuring to the DEADLINE was
    the first attempt and it looked safe: a hold cannot outlive the deadline
    either way. But half of the time-to-deadline, started just under the warning
    threshold, ends at 95% of the budget — so the slice the guard keeps for the
    run to produce a closing answer is half spent waiting for the result that
    answer was supposed to use. Against the finalize point the hold cannot reach
    that reserve at all, which is what makes the guard's inability to interrupt
    a hold a non-issue rather than a smaller issue.
  - **A floor of zero, deliberately.** A run with no time left before it must
    start finishing has no turn in which to read a notification. Nothing is
    dropped by it: the wait returns before it looks at its timer when a
    completion is already in hand.

  **What changes for you.** A run with a short `timeoutMs` finishes when it said
  it would instead of overrunning by minutes. A run with a long one keeps its
  worker instead of abandoning it. If you were relying on a fixed two-minute
  settle regardless of run configuration, set `timeoutMs` to about four and a half minutes to
  get the same hold.

- 585a592: A caller can ask which effort levels a model accepts.

  The answer existed, was modelled carefully, and was reachable only from inside
  one driver. That matters because effort is **refused, not clamped**: a level a
  model does not have makes the vendor reject the request, so a control offering
  the wrong one produces a run that fails at the start rather than a quieter one.

  Every option open to a caller without the answer was bad. Offering all five
  breaks some models. Offering the intersection hides `xhigh` and `max` from every
  model that has them, which is most of the reason to build such a control. And
  copying the table looks fine and is worst: the ceiling has moved twice already,
  so a copy goes stale on the next model and goes stale **silently**, surfacing as
  a vendor rejection rather than a failing build.

  **New optional `LLMProvider.effortLevelsFor(model, thinking?)`.** Three states,
  each meaning something different: the method absent means the driver has no
  effort concept at all and setting one will be refused; an empty array means the
  driver implements effort and this model has none; a non-empty array is the set
  to offer.

  **`thinking` is a parameter, and that is the point.** At least one model family
  accepts a narrower set while thinking is disabled than while it is on — so an
  API returning two sibling arrays invites a caller to render a picker from one
  and send the other, a combination the vendor rejects, on exactly one family.
  Passing the configuration you will actually send makes that unspellable: there
  is one answer and it is the one for your request.

  The driver's implementation shares the same two resolution steps the request
  path uses, so a caller's picker and the request it produces cannot disagree.

  `@namzu/anthropic` also now exports `resolveThinkingCapability`,
  `resolveThinkingBody`, `resolveEffort` and their types, for a caller that needs
  the fuller picture — whether thinking can be switched off at all, not only which
  effort levels apply. Prefer `effortLevelsFor` where it suffices: it is
  provider-agnostic and cannot return the wrong one of the two sets.

  Separately, the live wire-contract suite now retries a transient status rather
  than reporting it as a contract failure. A 529 says the service is busy and
  answers nothing about whether a schema is expressible — so a test named "every
  shipped tool is expressible on this wire" was claiming something the run had not
  established. That cost two manual re-runs in one day to discover the wire had no
  opinion.

### Patch Changes

- 9ac8dd4: A background task whose completion arrived early no longer holds the run open forever

  `CompletionInbox.drain()` handed the completion over and marked it claimed, but
  left the task on the OUTSTANDING set. That set is meant to hold ids that are
  still running, and only the gateway's completion listener takes an id off it —
  so if the listener ran BEFORE the launching call said `expect()`, the id was
  added to a set nothing would ever clear.

  That order is reachable rather than theoretical: `expect()` runs one microtask
  after `gateway.createTask()` resolves, and a worker that finishes fast is
  announced in between. The result of it was `hasPendingWork === true` for the
  rest of the run, with an empty inbox — so every attempt to settle waited out the
  full background grace period for a result that was already in the transcript,
  and did it again on the next turn, and the next.

  Nothing to do on upgrade. If you were seeing runs pause for two minutes before
  their final answer with no background work outstanding, this was why.

- 3d4315e: `PrepareStepResult.activeTools` documented the opposite of what it does.

  Its comment promised that unregistered names are dropped so a phase list
  outliving a tool rename would "narrow the surface, not kill the agent mid-run".
  Since the list began bounding what may RUN rather than only what the model is
  shown, dropping every name leaves the step able to call nothing — so the code
  and its own documentation had said different things.

  **The behaviour is right and the comment was wrong.** This list means "only
  these": when a rename outlives it, the only set satisfying "only the tools that
  no longer exist" is the empty one. Widening back to the run's list would grant
  precisely the tools the caller asked to exclude, on the grounds that their own
  list failed — a control that stops applying because it was aged out, which is
  worse than a step that answers from what it already has. The run continues
  either way; nothing crashes.

  The warning now distinguishes the two cases, because they have different
  consequences: some names dropped narrows the step, and all of them dropped
  leaves it unable to call anything. "Ignoring them" was accurate for the first
  and misleading for the second.

  **Worth knowing if you rely on this:** the warning goes to the logger, so a host
  that silences its logger sees a phase quietly stop doing anything. That is a real
  gap and it is named here rather than papered over.

## 7.0.0

### Major Changes

- 062624c: A bridged tool's positional array is no longer flattened to "an array of
  anything".

  `mcpJsonSchemaToZod` collapsed every positional array — both the draft-07
  spelling (`items` holding a list) and the 2020-12 one (`prefixItems`) — to
  `z.array(z.unknown())`. The schema makes a round trip, server JSON Schema → Zod
  → JSON Schema on the wire, so what was dropped was dropped from what the MODEL
  is shown: a server that spelled out `[string, number]` had the model told
  nothing about the positions, their types, or their order.

  **Why this is a major.** Where the server pinned the arity and closed the tail,
  the converted schema is now a tuple, so input that a looser array accepted is
  refused locally. It is only ever refused where the server itself declared it
  invalid — the error moves from the server's response to the local validator —
  but a host driving a bridged tool directly can see a validation failure it did
  not see before, and code branching on the converted type (`instanceof
z.ZodArray`) will take a different branch. If you relied on the permissive
  shape, the fix is to send what the server's schema declares.

  **The tuple is deliberately narrow, and that is the whole design.** A rejected
  tool schema fails the entire request rather than degrading one tool, taking down
  every run that offered the toolset — so a faithful conversion the wire will not
  accept is strictly worse than a lossy one it will. A tuple is therefore emitted
  only where the server pinned the arity AND closed the tail, because that renders
  as bounded `prefixItems`, which is the one positional shape measured as
  accepted and the same shape a first-party builtin already ships. Every looser
  positional array keeps today's permissive array and gains its shape in the
  description instead, appended to whatever the server wrote rather than replacing
  it.

  The inversion worth knowing if you write these schemas: positional members do
  not constrain LENGTH. Without `minItems` a server is permitting a shorter array,
  which a tuple cannot express — so an absent lower bound is a reason to keep the
  loose form, not a detail to round up.

  **Also fixed, and reachable from any bridged server:** the conversion's depth
  ceiling never fired. `MAX_CONVERSION_DEPTH` was compared against in one branch
  that a pure array or union never reaches, and the counter was not even passed
  down the array path — so a deeply nested schema from a remote tool listing took
  the process down with a stack overflow instead of being left permissive as the
  ceiling's own comment promised.

### Minor Changes

- bf0999d: a policy rule you wrote is actually consulted, and a refusal says what it said

  Two defects in the verification gate, found while designing an operator-facing
  permission surface on top of it.

  **A rule could be silently unreachable.** `allowReadOnlyTools` was expanded
  into a rule ahead of the operator's own, and the gate stops at the first match
  — so a rule like "prompt me before every read" was never consulted while that
  flag was on. Not rejected, not warned about, just never reached. Someone who
  writes a control and is silently ignored gets the worst outcome available: they
  believe it is in force and it is not.

  The read-only allowance now goes LAST, which makes it what it always was in
  substance — a default for tools nobody wrote a rule about, rather than an
  override of the rules they did write. **The dangerous-pattern denial still goes
  first and still outranks everything**, so an operator rule cannot open what the
  floor closes.

  **A refusal told the model nothing it could use.** The reason was built as
  `Matched rule: ${rule.type}`, so a denial arrived as _"Blocked by the
  verification gate: Matched rule: deny_by_name"_ — the KIND of rule and nothing
  about it. Not which tool, not which pattern, not whether a different input
  would fare better.

  That difference is behavioural, not cosmetic. Told only that it was denied, a
  model rewords the same call and tries again, because nothing says the retry is
  pointless. Told that a pattern rule denies `git push*`, or that a by-name
  denial is about the tool rather than the input, it can stop and say so. A
  refusal that cannot be reasoned about produces thrashing; one that can produces
  a route around it.

  `describeRule` is exported, so a host rendering its own approval UI can show
  the same sentence the model got.

- cb772c7: Export `describeRule` alongside `evaluateRule`.

  `evaluateRule` has been public for some time and answers only whether a rule
  matched. A host driving the rules directly — rather than through
  `VerificationGate` — was left holding a verdict with no words for it, and the
  only way to say anything about a refusal was to switch on the rule's `type`.
  That names the KIND of rule and nothing about what it said: not which tool, not
  which pattern, not whether a different input could ever help.

  That is the same defect the gate itself carried until its `reason` stopped
  being `Matched rule: <type>`, and it was left open one layer up for anyone
  using the rule primitives without the gate. The two now travel together.

  Nothing is removed and no behaviour changes. If you were deriving your own
  denial text from `rule.type`, `describeRule(rule)` is the sentence the gate
  uses, and it is worth reading before you keep your own.

- 062624c: `effort` can be set on a run — and so, for the first time, can `thinking`.

  `effort` was on the provider params, exported, and read by a driver that wrote
  it to the wire, and nothing in the kernel ever set it. Every request went out at
  the model's default, which reads as "this model ignores effort" rather than
  "nobody plumbed it through".

  `AgentRunConfig` gains `effort`, a sibling of `thinking` rather than a field
  inside it — on some models the two are independent controls that apply together,
  and nesting would make that combination unsayable. It is run-level rather than
  per-step because the provider documents that changing effort between requests
  does not preserve a cached prefix, so a value that moves between steps buys a
  different answer shape at the cost of the cache on every step that changes it.

  **`thinking` turned out to have the same defect, and had shipped with it.** It
  was settable only through `drainQuery`. Every ergonomic entry point — `runAgent`,
  `ReactiveAgent`, `SupervisorAgent`, and the agent manager's bare-config branch —
  builds its run config by hand-listing fields, so a field nobody remembered to add
  is dropped in silence, with no cast to blame and no error to see. A caller could
  set `thinking` on an agent config and get a run that never asked for it. Both
  fields now live on `BaseAgentConfig` and are forwarded by all four.

  This was found by watching an actual HTTP body from a real run. The unit tests
  passed throughout, because they drive the kernel directly, and the kernel was
  never the half that was broken.

  **A driver that cannot honour `effort` now refuses rather than dropping it**,
  the rule `thinking` already had. Effort is the worse silence of the two: a
  dropped `thinking` leaves an empty reasoning list someone might notice, while a
  dropped `effort` leaves a perfectly ordinary answer, so a run requested at `max`
  is indistinguishable from one at the default — including in what it cost.
  Nothing existing breaks, because the field could not be set until now.

  Two driver-side corrections ride along, both verified against the live wire:

  - The preview model's capability row claimed all five effort levels. It takes
    `max` and not `xhigh`. That model is not reachable from the tenant the live
    suite runs against, so the row is sourced from the reference rather than
    measured — but the pairing itself is now measured, on a model that has it:
    `claude-sonnet-4-6` answers `xhigh` with _"This model does not support effort
    level 'xhigh'. Supported levels: high, low, max, medium"_ and accepts `max`.
    Reading the levels as a ladder, where anything taking the top rung takes the
    one below, is what produced the wrong row.
  - `output_config` is now merged rather than assigned. It is a shared envelope on
    that wire — a structured-output format and a task budget live in it too — so
    assigning meant whoever wired the next one would silently delete effort, or
    have effort delete theirs, depending only on which line ran last.

- bf0999d: a delegated worker is bounded by how long it has been quiet, not only by how long it has run

  `DELEGATION_TIMEOUT_MS` gave the supervisor an hour to wait, which fixed the
  two-minute deadline that made the blocking path structurally unreachable. An
  hour of wall clock is still the wrong quantity to measure: it says nothing
  about whether the worker is doing anything.

  One number cannot answer both questions. It has to be generous enough for a
  child doing real work, which is exactly what makes it useless as a stall
  detector — so a worker wedged in its second minute held the supervisor for
  another fifty-eight, and a worker making steady progress at minute fifty-nine
  was cut off for being slow rather than for being stuck.

  There are two clocks now:

  - **the run bound**, elapsed time, never refreshed, still an hour. For a worker
    that stays busy forever.
  - **the idle bound**, time since the worker last did anything, reset on every
    progress signal. Five minutes, overridable with `NAMZU_DELEGATION_IDLE_MS`.
    For a worker that stopped.

  Whichever fires first ends the wait, and **the result says which** — "it went
  quiet" and "it ran too long" are different diagnoses that lead to different
  next moves, and the message is what a model acts on.

  Giving up on the wait does not cancel the worker. The child keeps going and its
  completion still arrives as a task notification, because a wait that ran out is
  a statement about the waiter, not about the work. Losing an eight-minute
  worker's output because a clock expired is the shape of the bug this whole area
  has been unpicking.

  **`TaskGateway.onTaskProgress` is new and OPTIONAL.** The idle bound needs a
  signal that a task did something, and only a gateway can see it. It is optional
  because hosts implement `TaskGateway` and not all of them can observe their
  children — a gateway without it is bounded by the wall clock alone, exactly as
  before. That degradation is deliberately visible rather than silent: the
  timeout result carries `idleBoundArmed`, and the message says outright that
  this gateway cannot tell a busy worker from a stuck one.

- 69d609a: six declarations that drive nothing are marked for removal

  An audit of the kernel found primitives that are declared, reachable from the
  published typings, and read by no code at all. None is deleted yet — they are
  on the public surface, so they get the deprecation release the repository's own
  policy asks for, and go in the next major.

  They are worth naming individually, because a dead declaration is not merely
  untidy. Each of these tells a reader something false:

  - `HOOK_MAX_CONCURRENT` reads as a concurrency cap that is in force. Hooks run
    sequentially and always have, so a reviewer reasons about batching that does
    not happen. Do not "fix" it by batching — ordering is the contract hooks are
    written against.
  - `MAX_RECENT_ACTIVITIES` — no list is trimmed to it.
  - `AgentTask.progress` and the `progress_updated` lifecycle variant are a whole
    reporting channel with **no producer**. A host that switches on the event has
    written a branch that cannot run; one that waits for progress waits forever.
  - `IterationCheckpoint.planStatus` is never set, so a host restoring a
    checkpoint to find out whether the plan was approved gets `undefined` for
    every run — approved or not — and cannot tell the two apart. Ask the plan
    manager.
  - `ProbeOptions.otel` is unimplemented: setting it changes nothing.

  Each now carries `@deprecated` and a note saying which of "unused",
  "no producer" or "unimplemented" applies, so the next reader does not have to
  re-derive it.

### Patch Changes

- bf0999d: `continue_task` is deleted rather than left defined and unreachable

  It was written, documented, and never returned from the coordinator builder —
  so no model could call it. The question was reopened when `background: true`
  made a live task id reachable again, since the reason it was dropped had been
  that a blocking launch leaves every worker terminal before a later turn learns
  its id, and the manager refuses `continue` on a terminal task.

  Measured instead of assumed, and it fails on the other side. On a LIVE task the
  manager accepts the call and pushes onto `pendingMessages` — and **nothing
  drains that queue during a run**. The codebase already knew: `steering.ts` says
  in as many words that `queueMessage`/`drainMessages` were never read by the
  iteration loop, and `SteeringChannel` exists because of it, delivering guidance
  on a tool result instead — a `tool_use` must be answered by a `tool_result`
  with the same id, so there is no legal slot for a user message mid-batch.

  So the tool had no state it worked in: terminal tasks refuse it, live tasks
  accept it into a queue nobody reads. Registering it would have handed the model
  a call that silently does nothing, which is worse than an unreachable
  definition — an unreachable one at least cannot be called.

  If follow-ups on a live worker are wanted, the work is a consumer for the queue
  or a steering channel that reaches a child. Not this tool.

## 6.2.0

### Minor Changes

- 9d4cf61: a supervisor can decline to delegate without lying about its roster

  `SupervisorAgentConfig` gains `allowDelegation?: boolean`, default `true`.

  The roster answered WHO a run may call. Nothing answered WHETHER it may call
  anyone, and the two are different questions. A host that runs one specialist by
  putting its persona into the supervisor shell and its id into the roster has a
  non-empty roster and must still delegate to nobody — and got the full
  delegation surface, discovering the refusal only by spending a turn on it.

  It cannot be derived. Comparing the roster against the executing agent fails in
  exactly that arrangement, because the ids differ. And no predicate over the
  roster could work: a supervisor whose roster holds one specialist and a run
  that IS that specialist are indistinguishable in it. So the caller states the
  fact and the SDK decides what it implies for its own tool surface — which also
  means the implied list cannot go stale, the way a caller-held list of tool
  names silently did when this surface went from two tools to four.

  Details worth knowing:

  - **`agent_task_list` stays.** A run that may not launch anything may still want
    to see what is running.
  - **`approve_plan` and `ask_user_question` are untouched.** They are the
    human-in-the-loop surface, not delegation.
  - **`allowDelegation: false` is absolute.** `runtimeToolOverrides` cannot put
    the tools back: the override pass runs over the tools this flag declined to
    build, and both values come from the same caller in the same call, so
    "must not delegate" plus "give it `create_task`" is a contradiction rather
    than extra knowledge. `agentIds: []` has always worked this way.
  - **Absent and `true` are identical**, so adopting the flag cannot change a
    caller that opts in explicitly.

### Patch Changes

- 9d4cf61: cancelling a task no longer deletes a result it had already produced

  `CompletionInbox.forget` cleared both the outstanding-work set and the queue of
  completions waiting to be announced. The second was wrong.

  A background worker finishes, its completion is queued for the next drain, and
  the model — told nothing yet, and reading a tool that says it cancels a
  _running_ task — cancels it. The run then reported `cancelled` over work that
  had been done, and the output existed nowhere else: not announced, not
  claimable, not readable through the listing.

  `forget` is about pending work, and a finished result is not pending work. It
  now narrows to the outstanding set. The asymmetry with `claim`, which does clear
  the queue, is deliberate: there a tool has just handed the model the same
  result.

- 6961d3b: a failing shell command now says what happened, and its own deadline is the one that fires

  **The failure path threw away everything useful.** The host branch of `bash`
  called `exec` with no `catch`, and `exec` rejects on a non-zero exit. So the two
  things an agent runs a shell for most — a test run and a build — both threw, the
  registry turned the throw into "the tool failed", and the stdout, stderr and
  exit code that explain why were discarded. The rejection carries all three.

  The sandbox branch a few lines above already reported them, so the same command
  told the model two different amounts depending on where it happened to run. It
  now reports the exit code, both streams, and — separately — whether the command
  ran out of time, because "timed out" and "exited 1" lead to different next moves
  and the model acts on the message.

  A caller-owned abort still propagates as an abort rather than being reported as
  a command failure.

  **Two clocks, one of them undeclared.** `bash` enforces the `timeout` it is
  given; the executor enforces a separate per-tool deadline, and with none
  declared here it fell back to its generic default — also two minutes. The two
  agreed by coincidence and diverged the moment a model asked for longer because
  it knew a build was slow: it got two minutes, from a clock it had not been told
  about, reported as an abandoned tool rather than as a command that ran out of
  time.

  The tool now declares a deadline above the ceiling its input accepts, so its own
  clock is the one that fires. A request past the ceiling is **refused** rather
  than silently clamped — a number the model was not told had changed is how it
  learns to distrust its own arguments. The ceiling is ten minutes, overridable
  with `NAMZU_BASH_MAX_TIMEOUT_MS`.

  **And it now has tests.** The only builtin that runs a shell had none, which is
  how the swallowed failure shipped. Thirteen cases, mutation-checked: neutralising
  the failure path fails four of them.

- 06fb51b: a run no longer kills its own process while waiting, mid-turn, and report success

  `namzu run` and `namzu run-stream` could not finish a turn. The first tool call
  completed and the process ended: no second turn, nothing written, no terminal
  event, **exit code 0**. A user asking for a two-step task was told nothing had
  gone wrong while nothing had been done.

  Every human-in-the-loop park went through a timer that was deliberately
  `unref`'d, so a pending park-recorder could never hold a process open after the
  run settled. The hazard is real and the intent was right; the scope was wrong.
  That promise is **awaited during the run**, on every park, including the
  automatic ones a headless run resolves instantly. An `unref`'d timer does not
  keep Node's event loop alive — so once the decision resolved and the run sat out
  the rest of the delay, the loop had nothing left in it that counted, and the
  process exited from under the run.

  The timer is cancelled now instead of unref'd. It stays ref'd while the run is
  genuinely waiting on it, and is cleared the moment the decision arrives, so
  nothing dangles past the run either. A park that had already begun recording is
  still awaited, so the unpark cannot race it.

  Measured before and after on the same command: before, three events and an
  unchanged file; after, the edit applied and a terminal event.

  **Why no test caught it.** A test runner holds the event loop open for the whole
  file, which is exactly the prop this bug hides behind — the entire suite passed
  throughout, including tests that drive real runs against a live provider. The
  regression test therefore spawns a real `node` process with nothing else in it,
  and lives in its own suite (`pnpm --filter @namzu/sdk test:proc`, run as its own
  CI step) because the spawn competes for CPU hard enough to flake the
  timing-sensitive tests beside it.

## 6.1.0

### Minor Changes

- ab0bb30: a worker that finishes now reaches the supervisor, without polling for it

  A delegated worker's output reaches the supervisor as the `tool_result` of
  the `create_task` that launched it. That works while the launching call is
  still the live path — and there are two situations where it is not:

  - the call hit the executor's deadline. The model was told _"timed out… it
    may still be running"_, with no task id, and the worker then finished
    normally holding a result nothing would ever read.
  - there was never a call waiting, because the launch was meant to run
    alongside the turn.

  In both cases the completion existed, the gateway remembered it, and the
  supervisor was never told. The one tool left to it, `agent_task_list`,
  reported id, state and duration — and dropped the worker's output, reading
  `result.status` and `result.lastError` off the handle while stepping over
  `result.result` between them. So a supervisor could learn that a task had
  definitely finished and still have no way to read what it said.
  `agent_task_list` in a sleep loop was not the model misbehaving; it was the
  only move on the board.

  **Completions are now delivered rather than polled for.** A run subscribes
  once through `onTaskCompleted` — which every `TaskGateway` already has, so
  no gateway changes — and anything a tool did not hand over inline arrives in
  the transcript as a task notification carrying the id, the agent, the state
  and the output.

  The distinction is the whole design. An earlier version of this channel was
  removed because it fired for completions the blocking tool had _already_
  delivered, so the supervisor saw each result twice. Tools now claim what they
  deliver, and only unclaimed completions are announced. A blocking
  `create_task` behaves exactly as it did.

  Three additions come with it:

  - `create_task` takes `background: true`, returning a `task_id` immediately
    so the supervisor can keep working.
  - `wait_for_task` joins a running task and returns its output. `continue_task`
    blocked, but only as a side effect of sending a message, so a supervisor
    that merely wanted to wait had to invent something to say.
  - `cancel_task` is mounted again. It was dropped on the reasoning that a
    blocking launch leaves every worker terminal before its id is known — true
    then, and untrue now that a background launch hands back a live one.

  `agent_task_list` also carries the worker's output, in the rendered text
  rather than only in `data`: the executor builds the model-facing tool result
  from `output` alone, so a field added to `data` would have been added
  somewhere the model cannot see.

  A run no longer settles while a background worker it launched is still
  running — it would have discarded the very result the launch existed to
  produce. The wait is bounded, so a worker that never finishes cannot hold a
  run open.

  `CompletionInbox` and `formatCompletionNotification` are exported for hosts
  that build the coordinator surface themselves.

- 529d10f: a narrowed step now narrows what can RUN, not only what the model is shown

  `prepareStep.activeTools` documents itself as _"restrict which tools the model
  may call this step, by name"_, and run-level `allowedTools` makes the same
  promise for a whole run. Neither restricted anything.

  The list decided which schemas went into the request. It was then copied into
  the tool context and read by nothing on the execution path — the registry gated
  on availability and plan mode, and never on the allow-list. So the narrowing was
  a statement about the menu rather than about the kitchen: a model that named a
  withheld tool had it run.

  That is not a hypothetical. A model names a tool it was not offered whenever it
  repeats a call from earlier in the context, whenever a gateway carries its own
  tool list, and whenever a cached prompt prefix is replayed. A host using this to
  fence a step — the obvious use, and the one the type invites — was fenced by
  nothing.

  The check now sits where the call is made. A tool outside the list is answered
  with a refusal that names what IS available, so the model can route around it
  rather than guessing.

  Two details worth stating:

  - **Absent is not empty.** No list means no restriction; an empty list means the
    step may call nothing. Reading an empty allow-list as "unrestricted" is the
    fail-open this repository has already been bitten by once, in the delegate
    roster.
  - **A step's list beats the run's,** matching the precedence the request already
    used, so the two can no longer disagree.

  **If you pass `allowedTools` or `activeTools` today, calls that previously ran
  may now be refused.** That is the point of the change, but it is a real
  behavioural difference: a run that quietly depended on the leak will start
  seeing refusals. The refusal is a normal `tool_result`, so the turn continues.

### Patch Changes

- 529d10f: a delegated child is no longer strangled by a file-read deadline, and a closed tuple stays closed

  **The deadline.** `create_task` runs an entire agent and inherited the tool
  executor's generic two-minute default — the one whose own docstring says _"a
  tool that legitimately runs longer declares its own `timeoutMs`"_. It did not.

  Measured on real traffic: three delegated children finished in 4m21s, 5m58s and
  8m04s while all three parents timed out at 120s. The children were never killed
  — only the parent's wait was — so the blocking path was not occasionally missed,
  it was structurally unreachable, and the supervisor was left calling
  `agent_task_list` in a sleep loop because nothing else was available to it.

  `DELEGATION_TIMEOUT_MS` is now one hour, exported so it is greppable, and
  applied to `create_task`, `wait_for_task` and `continue_task`. An hour rather
  than "a bit more than eight minutes" because a generic stopwatch is the wrong
  instrument for a child that is making progress: a failure should come from what
  the child is doing. A wedged child is still caught, and the run budget and
  iteration ceiling both still apply above this.

  **The instruction to poll was ours.** `agent_task_list` described itself as the
  way to _"confirm every launched task reached `completed`"_ and as _"safe to call
  repeatedly"_ — an order to burn a turn on a listing whose answer a blocking
  `create_task` had already delivered. It now says the opposite, and points at the
  cases the listing is actually for. `create_task` gained the matching clause in
  the other direction: until a worker's result arrives, do not fabricate,
  summarise or predict it.

  **The tuple.** `toSchemaDialect` translated draft-07's `additionalItems: false`
  by dropping it, on the reasoning that 2020-12 closes a tuple by default. It does
  not — with `prefixItems` set and no `items`, elements past the tuple are
  unconstrained — so every closed tuple was silently widened into an open one. A
  schema written to forbid a third element began to allow any number. It now
  emits `items: false`, which the wire accepts.

## 6.0.0

### Major Changes

- f8355de: a failed request now carries the provider's own account of why, scrubbed

  `ProviderRequestError` has always declared a `detail` field. The constructor
  never read it, so it existed and carried nothing, and the response body was
  parsed to classify the failure and then dropped.

  That was deliberate and it was an over-correction. An error body can echo a
  request and a request can carry a credential — but a provider rejecting a
  request also names the exact offending field, and deleting that sentence turns
  a one-line diagnosis into hypothesis elimination against a live API. It did:
  the wire spent a day of production downtime repeating
  `tools.0.custom.input_schema: … must match JSON Schema draft 2020-12` while the
  SDK removed the sentence before anyone could read it.

  Scrubbing what is credential-shaped and keeping the rest is the trade that was
  actually available. `detail` now carries the provider's message, truncated to
  400 characters, with API-key prefixes, bearer headers, cloud access-key ids and
  credential-named JSON fields replaced by `[redacted]`. The same text reaches
  `message`, so a log line that prints only the message is enough to act on.

  It reaches the run too. `ProviderErrorInfo` — the metadata on failed runs and
  `run_failed` events — had no `detail` field, so the sentence stopped at the
  error object and a host rendering `run.lastProviderError` still had to parse
  `error` to learn which parameter was rejected. That is the re-parsing the
  structured field exists to avoid, so `detail` is on it now:

  ```ts
  if (run.lastProviderError?.kind === "bad_request") {
    console.error(run.lastProviderError.detail);
  }
  ```

  **Breaking.** The previous contract — "the response body is never interpolated
  into the error message" — was documented, and code may depend on it. Two tests
  in this repository did. If you log `ProviderRequestError.message` somewhere the
  provider's own words must not appear, read `error.kind`, `error.status` and
  `error.providerId` instead and build the string yourself; those are unchanged.

  What has NOT changed is the `cause` chain: the raw body is still never attached
  as `cause`. A `cause` survives every logger that serializes an error chain,
  which is the channel that would leak the body regardless of what the message
  says.

  The strict-subset check learned the same lesson in the same release. Its
  deny-list was derived from prose and was wrong in both directions — it refused
  `minLength`/`maxLength`, which the wire accepts, so it would have blocked
  working tools; and it permitted tuples, which the wire rejects, so it vouched
  for a broken one. It is now measured against the live API, and the measurement
  runs as a contract test rather than living in a comment. `minItems` in
  particular is a bound on the _value_, not a rejected keyword: 0 and 1 pass and
  anything above does not, so a required non-empty array is expressible again.

### Minor Changes

- f8355de: tool schemas are rendered in the dialect each wire actually parses

  A tool with a tuple-shaped field took down every request that offered it. The
  kernel renders one canonical JSON Schema in draft-07, where a tuple is
  `items: [a, b]`; one of the wires namzu speaks validates tool input as JSON
  Schema 2020-12, where that spelling is invalid and a tuple must be
  `prefixItems`. Every driver forwarded the rendering verbatim, so the built-in
  `read` tool — whose `readRange` is a Zod tuple — produced a 400 that rejected
  the **whole** request, taking every other tool in the call down with it. The
  turn died before generating a token.

  The failure had nothing to do with strict tool use, which is why the guard
  added for the previous schema outage never saw it: it fires with strict
  validation unset, and with strict on the dialect error arrives _first_.

  Which dialect a wire parses is a property of the wire, so the conversion now
  happens at each driver's boundary rather than in the renderer:

  ```ts
  import { toSchemaDialect, findDraft07Only } from "@namzu/sdk";

  toSchemaDialect(schema, "2020-12"); // items: [a, b]  ->  prefixItems: [a, b]
  findDraft07Only(schema); // paths that no 2020-12 parser will accept
  ```

  `renderToolSchema` is exported now too, so a caller assembling its own tool
  payload gets the same memoized, `$schema`-stripped, deep-frozen rendering the
  kernel puts on the wire — byte-identical across iterations, which matters
  because the tools block sits at position 0 of the prompt-cache prefix.

  `ToolCatalog` used to convert schemas through its own inline call with the same
  options. Same output, none of the guarantees: no `$schema` stripping, no
  memoization, no freeze. It goes through `renderToolSchema` now.

  **Breaking, for the three drivers.** Their `@namzu/sdk` peer range was
  `>=1.3.0` and is now `>=6.0.0`. That range was already wrong — the drivers call
  kernel functions added well after 1.3.0 — and it would now let a package
  manager install a combination that throws on every request carrying a tool.
  Upgrade the kernel alongside the driver.

  The conversion follows the model on multi-vendor wires. Bedrock's Converse API
  carries several vendors through one request shape, and the 2020-12 requirement
  was measured on one of them, so schemas bound for the others are left in the
  dialect they were rendered in. Guessing there would trade a known break for an
  unmeasured one.

## 5.2.0

### Minor Changes

- 604a56a: completed is not succeeded — run_completed says why it stopped, and namzu run exits accordingly

  `run_failed` is emitted from exactly one place in the kernel: the throw path.
  Every other way a run can end badly arrives as `run_completed` — the token
  budget, the timeout, the iteration cap, a cancellation, a rejected plan, a
  refused structured output, and both guardrails.

  Measured: a `max_iterations` stop reports `status: 'completed'`, and the event
  carried nothing that distinguished it from an answered question.

  **SDK.** `run_completed` now carries `stopReason`. It is optional and additive,
  so nothing breaks; a consumer that wants to tell "answered" from "ran out of
  budget" no longer has to hold the `Run` alongside the event stream.

  **CLI — read this before upgrading if you script `namzu run`.** The command
  exited `0` for all of those. The sharp case is the output guardrail: an answer
  that was _refused_ exited `0` with empty text, so

  ```sh
  namzu run "write the release notes" > notes.md && publish notes.md
  ```

  published an empty file and reported success. `namzu run` now exits `1` when
  the run did not finish normally, and names the reason on stderr. The text still
  prints — partial output is real output, and a caller who piped it wants what
  there is — but `$?` can now say it is partial.

  If you have a script that depends on `namzu run` exiting 0 for a truncated run,
  it was depending on not being told. Check `$?` and read the stderr line.

  Also in the CLI, internally: the `done` agent event's `finishReason?: string`
  had no producer and no reader anywhere in the package, and the name belonged to
  a different concept — a "finish reason" here is `MessageStopReason`, reported
  per model message, not the run-level `StopReason` a caller asks about at the end
  of a turn. Replaced by `stopReason`. The type is not exported from the package
  entry, so this is internal.

- f25ebce: a model id's date suffix is no longer read as its minor version

  Three copies of one regular expression matched Claude model ids — the capability
  table plus two drivers — and all three had the same defect: the minor-version
  group was `(\d+)`, which swallowed the 8-digit date suffix.

  Measured against the shipped pattern:

  ```
  claude-sonnet-4-20250514   ->  major=4  minor=20250514
  claude-opus-4-1-20250805   ->  major=4  minor=1
  ```

  So a dated id naming no minor version compared as enormously _newer_ than one
  that does, and every capability gate keyed on `minor >= n` inverted for exactly
  those ids. `claude-sonnet-4-20250514` was classified as a 4.7+ model: the driver
  sent it `thinking: {type: 'adaptive'}`, silently discarding a caller's
  `budgetTokens`, and cleared the 4.5 gate that enables strict tool inputs.

  `parseClaudeModelVersion` and `claudeVersionAtLeast` are now exported from
  `@namzu/sdk` and used by both drivers and the capability table. A real minor
  version is one to three digits; a date is eight, and the group is bounded
  accordingly. An id the parser does not recognise makes `claudeVersionAtLeast`
  return `false` — a capability gate must not open for a name it does not
  understand.

  The comment above the old parser warned that "a second, subtly different model
  matcher is how two capability decisions drift apart on the same model name."
  There were three.

- 5496fb2: the agent-directory loader is part of the SDK

  It shipped briefly as a separate package. The name was the tell: nothing fit.
  `project` collided with `ProjectId`, the tenancy bucket every run already
  carries, and it described a scope that no longer existed once `channels/` and
  `schedules/` were cut. `agent-dir` was a hyphenated abbreviation, out of family
  with `skills`, `plugin`, `registry`, `sandbox`.

  A directory reader that needs the kernel to be useful is a function of the
  kernel, not a product beside it. So it is one now:

  ```ts
  import { loadDirectory, deriveRunOptions, runAgent } from "@namzu/sdk";

  const { manifest, ok, diagnostics } = await loadDirectory("./agent");
  if (!ok) console.error(diagnostics);

  const { output } = await runAgent(
    deriveRunOptions(manifest, { provider, prompt: "What is the weather?" })
  );
  ```

  Nothing about the convention changed — the same `agent.ts`, `instructions.md`,
  `tools/`, `skills/`, `agents/` layout, the same `modules: 'skip'` mode, the same
  diagnostics, the same `deriveSupervisorOptions` for a directory that declares
  delegates. Only the import path and the names.

  **Nobody has to migrate.** The package was never published — a `@namzu/project`
  install has always 404'd — so there is no consumer to move and no deprecation
  window owed. The rename that would have cost a major after publishing cost
  nothing before it.

  Renames, if you were following the source: `loadProject` → `loadDirectory`,
  `ProjectManifest` → `DirectoryManifest`, `ProjectConfig` → `DirectoryConfig`,
  `ProjectSlot` → `DirectorySlot`, `ProjectLoadResult` → `DirectoryLoadResult`,
  `ProjectDiagnostic` → `DirectoryDiagnostic`, `LoadProjectOptions` →
  `LoadDirectoryOptions`. `DiagnosticCode` and `DiagnosticSeverity` gained a
  `Directory` prefix as well — bare, in a shared namespace, they read as the
  SDK's own diagnostic vocabulary rather than one loader's.

  A side effect worth naming: `@namzu/project` was the one package the release
  pipeline could not publish, so every release since `#102` ended red on its
  `E404`. That failure goes with it.

- ca64062: runAgent forwards skills and the verification gate

  `runAgent` built its `drainQuery` call with an `as never` cast. The cast was
  not load-bearing — removing it typechecks clean — but while it was there the
  kernel seam was unchecked in both directions, and two options the kernel
  accepts were never forwarded.

  **`skills`** is the one with a caller. `@namzu/sdk` reads a whole `skills/`
  directory, puts them on the options, and every one was dropped: the run was
  assembled without them and nothing reported it. If you passed `skills` to
  `runAgent` and wondered why the model behaved as though it had never seen them,
  this is why. No change needed on your side — the field now arrives.

  **`verificationGate`** is the safety one. The kernel builds a `VerificationGate`
  from it and consults it on every tool call; the front door had no way to supply
  one, so a `runAgent` run was strictly less mediated than a `drainQuery` run. A
  host that hands `runAgent` an agent directory it did not write should now set
  it.

  Both are optional and default to today's behaviour, so nothing breaks.

  Three fixes in `@namzu/sdk`, each a check that existed and read the wrong
  thing:

  - **A tool with no `inputSchema` is refused.** It used to pass `isToolDefinition`
    — which checked only `name` and `execute` — register clean, then die inside
    `toLLMTools()` on `inputSchema._def`, in a `TypeError` naming neither the tool
    file nor the loader. The check is now the four fields `ToolDefinition`
    declares as required, and no more: demanding `defineTool`'s extras would make
    the loader refuse an object the SDK's own published type accepts. A directory
    that previously loaded with `ok: true` and crashed on first use now loads with
    `ok: false` and a `not_a_tool` diagnostic naming the file.
  - **Import failures explain themselves again.** `explainImportFailure` chose its
    hint by matching Node's error code against `err.message`, and Node does not
    put the code in the message — probed: `ERR_MODULE_NOT_FOUND` arrives as
    "Cannot find module …". Every hint in the function was unreachable. It reads
    `err.code` now, and a Node too old for type stripping gets a hint of its own.
  - **`metadata` values are checked.** Typed `Record<string, string>` and admitted
    on `typeof === 'object'` alone, which an array also satisfies and which says
    nothing about the values, so `{ count: 1 }` and `["a"]` both reached a
    consumer that had been promised strings.

- 61ca851: a tool whose schema cannot carry the guarantee it asks for is refused at registration

  The previous release fixed the `edit` tool's schema and added a check in the
  Anthropic driver. That caught the bug, but in the wrong place: per request, in
  one of the **two** drivers that mark tools strict, and only once something
  actually ran.

  `ToolRegistry` already refused `enforceModelInput` without a
  `modelInputSchema`, and the comment above that check states the principle
  exactly — _"Refusing at registration puts the error where the author can fix it
  rather than at the first request."_ The rule was written down; the new check was
  somewhere else.

  It is now beside its sibling. One asks whether a model schema **exists**; the
  other asks whether it can **carry the guarantee the tool just requested**. A
  tool that asks for constrained generation and supplies a schema the constrained
  dialect cannot express is wrong at the moment it is declared, whichever model it
  later meets — so it never registers, and can never reach a request.

  ```
  Tool "edit" is marked for strict input validation, but its model-facing schema
  uses 1 construct(s) the strict subset does not accept…
    edit.properties.insertLine.oneOf — use `anyOf` — for disjoint branches the two are equivalent
  ```

  This is the only path that matters in practice: the kernel builds its tool list
  with `ToolRegistry.toLLMTools()`, so every tool reaching a driver through the
  normal loop passed the gate.

  **A tool that never asked for the guarantee is untouched.** Without
  `enforceModelInput` nothing is marked strict, the schema is sent as ordinary
  JSON Schema, and `oneOf` is perfectly legal there. Refusing it would break
  working setups for no reason.

  `@namzu/http` also marks tools strict and had no check at all — the same bug
  was reachable through it. It now has the driver-level check the Anthropic driver
  already carried. Both remain as a second boundary for a host that hand-builds
  `ChatCompletionParams` and calls a provider directly, bypassing the registry.

  **If you author a tool with `enforceModelInput: true`,** a schema using `oneOf`,
  `not`, `if`/`then`/`else`, numeric or length bounds, `patternProperties`, or an
  `additionalProperties` other than `false` now throws at registration instead of
  failing the first request that carries it. The message names the path and the
  replacement.

- f25ebce: the edit tool's schema could not be sent under strict validation

  Strict tool input is not "JSON Schema, enforced" — it is a **subset** of JSON
  Schema, and a keyword outside that subset is not degraded. The vendor rejects
  the whole request, so one unexpressible field in one tool takes every other
  tool down with it and the turn dies before producing a token.

  The `edit` tool declared its integer-or-`"end"` field with `oneOf`, which is
  outside the subset while the equivalent `anyOf` is inside it. Measured against
  the live API:

  | body                      | result                                           |
  | ------------------------- | ------------------------------------------------ |
  | `strict: true` + `oneOf`  | **400** — `Schema type 'oneOf' is not supported` |
  | `strict: false` + `oneOf` | accepted                                         |
  | `strict: true` + `anyOf`  | accepted                                         |

  The middle row is why nothing caught it. Neither half is wrong on its own — the
  schema is valid JSON Schema, and marking the tool strict is correct policy — so
  no test of either one failed. Only the pairing did, and the pairing had no
  owner. Every agent using the built-in `edit` tool on a model at or above the
  strict gate lost its first tool-carrying turn to a 400.

  `oneOf` is now `anyOf` (equivalent here — the branches are disjoint), and
  `minimum` is gone from the model-facing schema for the same reason: numeric
  bounds are outside the subset too. The bound is not lost, the execution schema
  still enforces it.

  **The general fix is the second half.** `assertStrictSchema` and
  `findStrictSchemaViolations` are exported from `@namzu/sdk`, and the driver now
  checks every schema it is about to mark strict — refusing with the exact path
  and the remedy rather than letting the request go and getting back an error
  that names the keyword but not where it lives:

  ```
  Tool "edit" is marked for strict input validation, but its model-facing schema
  uses 1 construct(s) the strict subset does not accept…
    edit.properties.insertLine.oneOf — use `anyOf` — for disjoint branches the two are equivalent
  ```

  A test sweeps every built-in tool that asks for strict validation, so the next
  one is caught in the suite rather than in production.

- f25ebce: a directory-derived supervisor now has a token budget, a wall clock, and its skills

  `BaseAgentConfig` declares `tokenBudget` and `timeoutMs` as **required**.
  `deriveSupervisorOptions` supplied them only when `agent.ts` happened to name
  them — the uncommon case — and an `as SupervisorAgentConfig` made that compile.
  The returned object was therefore typed `tokenBudget: number` while holding
  `undefined`.

  That is not a type-level nicety. `buildLimitConfig` defaults only
  `maxIterations`, so an undefined budget and timeout disable **both** hard stops:
  a supervisor derived from a directory ran with no token cap and no wall clock.
  And the child-spawn guard computes a delegate's allocation from the parent
  budget, so `undefined` became `NaN` — and `NaN <= 0` is `false`, meaning the
  refusal that exists to stop an unfunded child let it through with a `NaN`
  budget.

  Both now default to the same numbers `runAgent` uses, which are exported as
  `DEFAULT_TOKEN_BUDGET`, `DEFAULT_TIMEOUT_MS` and `DEFAULT_MAX_ITERATIONS` so the
  two front doors cannot drift. Anything `agent.ts` declares still wins, and
  `overrides` still wins over that.

  The cast is now `satisfies`, so the next missing required field is a compile
  error rather than a run with its limits quietly switched off.

  Same file, same cast: `skills` were loaded from the project's `skills/`
  directory, put on the manifest, and then left out of the config the supervisor
  actually ran with. `SupervisorAgentConfig` accepts them and the kernel drives
  them; they are now supplied.

- c6b8aa8: An agent directory can declare delegates, and `deriveSupervisorOptions` turns them into
  a `SupervisorAgent` configuration.

  `SupervisorAgent` needs an `agentIds` roster and a manager that can spawn them.
  Nothing led from a directory to either, so a multi-agent system could be
  described on disk and not run.

  A directory under `agents/` is read by the same loader that read the root — a
  delegate has the same shape as its parent, so this is recursion rather than a
  new concept.

  ```
  agent/
  ├── instructions.md
  └── agents/
      ├── researcher/   ← its own agent.ts, instructions.md, tools/
      └── writer/
  ```

  `deriveSupervisorOptions` supplies the roster and leaves the manager to the
  host, the same contract `deriveRunOptions` follows: it converts, it does not
  run. Delegates come back as plans rather than registered agents, because
  registration mutates the host's manager and a function that quietly mutates an
  object it was handed for reference is the surprise this package avoids.

  A delegate may name its own model and inherits the coordinator's only when it
  does not — a cheap model for a narrow job is the common case, and inheriting
  unconditionally would bill every specialist at the coordinator's rate.

  **One level only.** A delegate may not declare delegates of its own. How deep a
  system fans out is a topology decision that belongs to whoever composes it, and
  answering it by default is how a directory layout ends up deciding a system's
  shape. It also removes the cycle: `agents/a/agents/b/agents/a` cannot be built
  if the second level is never read.

  A delegate that fails to load is reported in the parent's diagnostics, prefixed
  with its path, and is not offered in the roster. A caller reading one list
  should not have to walk the tree to find out the run will be short a specialist.

### Patch Changes

- f25ebce: the fork-bomb entry in the dangerous-command list could not match a fork bomb

  `DANGEROUS_PATTERNS` is what the `deny_dangerous_patterns` verification rule
  consults, and what `namzu run`'s own docstring means when it promises that in a
  non-interactive run "the safety gate still hard-denies catastrophic commands".

  The fork-bomb entry was written `/:(){ :\|:& };:/`. In a regular expression
  `()` is an empty capture group, not two literal parentheses — so that pattern
  described the string `:{ :|:& };:`, which is not valid shell and which nobody
  would ever type. Probed: it returned `false` for `:(){ :|:& };:` and for every
  other spelling of it.

  The replacement matches on **self-reference** rather than on one literal
  spelling — a fork bomb is a function whose own name appears on both sides of a
  pipe, is backgrounded, and is then invoked. So `bomb(){ bomb|bomb& }; bomb` is
  denied along with the `:` form, while `watch(){ tail -f log | grep E & }` — a
  function that merely contains a pipe and a background job — is not.

  No test named a fork bomb before this change, which is how it survived. There
  are now sixteen.

- c8672ed: The plugin subsystem contains its paths. It had none, and it is the part of
  this SDK that loads third-party code.

  **A manifest could name any file on disk.** `PluginLifecycleManager` built its
  import path with `join(plugin.rootDir, toolPath)`, and `toolPath` comes out of
  the plugin's own manifest — a file the plugin author writes. A manifest reading
  `"tools": ["../../../../somewhere/evil.js"]` left the plugin directory entirely
  and was imported, which is to say executed, in-process. The same held for
  `hooks`. Both now resolve through `resolveWithinReal`, so a path that escapes
  the plugin root is refused before anything is imported.

  **Discovery followed symlinks.** `discoverPlugins` used `stat`, which reports
  on a link's _target_, so a symlinked entry pointing anywhere on disk was
  admitted as a plugin directory and its manifest read from there — the directory
  listed was not the directory loaded (CWE-59). It now uses `lstat` and refuses a
  link with a warning naming the path.

  Found by comparing the plugin loader against `@namzu/sdk`'s scanner, which
  was written this week with both protections. The subsystem that had them was
  the one loading code the repo's own reviewers wrote; the one without them was
  the one loading code from a home directory those reviewers never see.

  If you ship a plugin whose manifest points outside its own directory, it now
  fails at enable with a message naming the path. Move the file inside the plugin.

## 5.1.0

### Minor Changes

- 8dbb98b: Adds `@namzu/project` — a conventional agent directory, read into typed,
  inspectable definitions.

  ```
  my-agent/agent/
  ├── agent.ts          # optional — model, temperature, budgets
  ├── instructions.md   # optional — the system prompt
  ├── tools/search.ts   # default-exports defineTool(…)
  └── skills/plan-a-trip/SKILL.md
  ```

  ```ts
  const { manifest, ok, diagnostics } = await loadProject("./agent");
  await runAgent(deriveRunOptions(manifest, { provider, prompt: "go" }));
  ```

  A **loader, not a runner**, and not in `@namzu/sdk`: the kernel does not
  mandate a directory layout any more than a kernel mandates `/etc/foo.conf`.
  `deriveRunOptions` returns ordinary `RunAgentOptions`, so there is no second
  code path and no behaviour reachable only through the convention.

  **Importing a directory runs it.** `loadProject` imports every module-backed
  file, in this process, with this process's privileges — a top-level side effect
  in `tools/search.ts` happens during the load. There is no in-process boundary
  that would change that, and `@namzu/sandbox` confines tool execution rather
  than module import. For a directory whose author you are not,
  `modules: 'skip'` imports nothing while still returning the full structural
  truth: every path, the instructions, the skills, duplicate detection. That is
  also the mode a CI gate and a UI file tree want.

  **TypeScript without a build step.** Files load through `await import()`, so
  `.ts` is handled by Node's own type stripping. Stripping erases types rather
  than transforming code, so `enum`, decorators, parameter properties, runtime
  `namespace`, extensionless relative imports and tsconfig `paths` aliases do not
  work — the README tables each one against what to write instead, and the errors
  name the remedy. A host that needs them passes `importModule` and hands in
  `jiti` or a `tsx`-registered importer: three lines in the host, no bundler in
  this dependency tree.

  **Nothing fails silently.** A file that cannot load is reported with its path
  and reason, never dropped. Two behaviours worth knowing: a symlink is refused
  rather than followed, because the file that would be imported is not the file
  that was listed; and a timed-out import is `'abandoned'`, not `'failed'`, since
  `import()` cannot be cancelled — the module may still finish, and Node caches
  it, so a later load in the same process can see the same file succeed.

  `channels/` and `schedules/` are **not** in this version. A trigger of
  `{ id, handler }` cannot express a signed webhook — verification needs the raw
  body, and a handler receiving a parsed one can never check an HMAC — carries no
  idempotency key while webhooks retry and schedules double-fire, and a cron
  field with no timezone story is a declaration nothing drives. Each would be a
  breaking change to a published type; the shape question gets its own pass.

  `@namzu/sdk` additionally exports `resolveWithin`, `resolveWithinReal` and
  `isWithin`, the containment helpers its own filesystem tools use. They were
  internal while three call sites outside that file needed them.

### Patch Changes

- 7ac89da: A driver that classified its own failure was being punished for it, in two
  places, and both shipped in 5.0.0.

  **`classifyProviderError` never read `kind`.** A `ProviderRequestError` — the
  type first-party drivers throw when they have diagnosed a failure themselves —
  fell through to the status heuristics, where a carefully-determined
  `context_overflow` carrying a 400 became `invalid_request`. Three of the six
  kinds landed wrong that way:

  | kind               | was                              | now                                      |
  | ------------------ | -------------------------------- | ---------------------------------------- |
  | `context_overflow` | `invalid_request`, not retryable | `context_length_exceeded`, not retryable |
  | `server`           | `invalid_request`, not retryable | `server_error`, **retryable**            |
  | `network`          | `invalid_request`, not retryable | `network`, **retryable**                 |

  The overflow case was not cosmetic. The run loop reaches for compaction when it
  sees `context_length_exceeded`, so relief — the one provider failure this
  kernel can actually do something about — was unreachable for exactly the
  drivers that had diagnosed the problem correctly.

  **`withProviderRetry` rethrew such errors before the retry loop.** Its comment
  justified preserving the driver's classification, which is right; the code also
  skipped retrying, which is a separate decision nobody made. A first-party HTTP
  or OpenRouter driver reporting a 429 as `kind: 'throttle'` got exactly one
  attempt, while the identical failure from a driver that classified nothing got
  the full backoff.

  Retry is now decided the same way for both, from the classification's
  `retryable`. The original error still escapes to the run boundary, so
  `run.lastProviderError` keeps reporting the driver's own
  `{ kind, status, retryAfterMs }` — wrapping there would have fixed the retry
  and lost the vendor's `kind`, which the existing stream-recovery test caught.

  **What changes for you.** A 429, a 5xx or a socket failure from
  `@namzu/http` or `@namzu/openrouter` is now retried with backoff instead of
  failing on the first attempt, and a context overflow from those drivers now
  triggers compaction instead of failing the run. If you were relying on a typed
  error failing fast, `retry: { maxRetries: 0 }` on `drainQuery` restores that.

## 5.0.0

### Major Changes

- 1cd1094: Thinking is now resolved per model, `effort` is sendable, and thinking tokens
  are reported.

  **Thinking on a current model was a failed request, not a degraded one.** The
  driver mapped `type: 'enabled'` straight to the wire and everything else to
  `disabled`. The vendor rejects a mismatched mode with a 400 rather than
  falling back: `thinking.type.enabled` is refused from Claude 4.7 onward,
  `adaptive` is refused on 4.5 and earlier, and the always-on models refuse
  `disabled`. One body for every model does not compromise quality, it fails.

  `ThinkingConfig.type` gains `'adaptive'`, and the Anthropic driver resolves the
  declared intent against the model it is about to call — sending the mode that
  model accepts, dropping a budget where budgets have no meaning, and omitting
  the field entirely rather than asking an always-on model to stop thinking. An
  unrecognised model is treated as manual-only, which is the previous behaviour
  and keeps a gateway serving an older model working.

  **`ThinkingConfig.display` is narrowed to `'summarized' | 'omitted'`**, and now
  actually reaches the wire. It was `'full' | 'summarized'`: `'full'` is not a
  value any vendor accepts — a declared option that could only ever have been
  rejected — and `'omitted'` was missing. It also was not serialized at all,
  which matters more than it sounds: `display` defaults to `'omitted'` on newer
  models, so a caller wanting to show reasoning received thinking blocks with
  empty text and nothing to explain why.

  **`effort` is new on `ChatCompletionParams`** — `'low' | 'medium' | 'high' |
'xhigh' | 'max'`. It goes out as `output_config.effort`, a _sibling_ of
  `thinking` rather than a field inside it, because it shapes the whole response
  and one manual-mode model accepts it alongside a token budget; nesting it would
  have made that combination unsayable. It is dropped on models that do not
  accept it, and refused in the one combination the vendor rejects — thinking
  disabled at `xhigh`/`max`.

  **`TokenUsage.reasoningTokens`** carries `output_tokens_details.thinking_tokens`
  when the vendor reports it. It is a _subset_ of `completionTokens`, not an
  addition — reasoning is billed as output, so summing it into a total would
  double-count. Absent means not reported, never zero: coercing would claim every
  turn on every silent driver did no thinking, and streamed events carry the
  breakdown only on the final delta.

  **Migration.** `display: 'full'` no longer compiles — use `'summarized'`, which
  is what it meant. Code passing `thinking: { type: 'enabled', budgetTokens }`
  keeps working and is now translated per model instead of rejected by newer
  ones. `assertThinkingSupported` in `@namzu/openai` refuses `'adaptive'` as it
  already refused `'enabled'`, since that driver implements neither.

  Not changed: a report accompanying this work claimed `temperature`, `top_p` and
  `top_k` are rejected on 5-series models and should be dropped by the driver.
  The Messages reference, the extended-thinking page and the thinking
  troubleshooting page document no such restriction, so nothing was implemented —
  silently dropping sampling parameters that would have worked is its own defect.

### Minor Changes

- 19d6a0f: A host can now steer a turn that is already running.

  `AgentManager.queueMessage` and `drainMessages` have existed for a while and
  nothing in the iteration loop ever read them — the type said so outright. So a
  host watching a run go the wrong way had two options, both worse than they
  sound: cancel and start over, throwing away every tool result already paid
  for; or reject through the review gate, which only works when a call happens
  to be pending approval and says "no" when the host meant "yes, but read this
  first".

  `SteeringChannel` is the delivery that was missing. A host holds one, passes
  it as `steering` on `drainQuery` params or `SupervisorAgentConfig`, and calls
  `steer(text)` whenever it likes. Anything queued while a tool batch is running
  is appended to that batch's **last tool result**.

  That slot is not a stylistic choice. A `tool_use` block must be answered by a
  `tool_result` with the same id, so a user message wedged between them is
  rejected by the provider — there is no legal place to insert one mid-batch.
  The tool result is the slot that already exists, and this SDK had already
  reached that conclusion for the neighbouring case: a denied call carries its
  reason inside the `tool_result`, precisely because that is where the model
  looks for tool outcomes. Steering is the same delivery with the refusal taken
  out.

  It deliberately does not interrupt. The batch in flight finishes and the
  guidance lands where the model reads next; a host that wants the current work
  stopped wants `AbortSignal`, which is a different question. Conflating them is
  how "also check the tests" ends up killing a half-written file.

  Details worth knowing:

  - Repeated calls before a drain accumulate in order rather than replacing each
    other — two corrections typed a second apart are two things the model should
    see.
  - Guidance is labelled as coming from the operator. Unlabelled it would read
    as something the tool said, so "stop and ask me first" would look like
    output from `bash`. This is not the untrusted-content envelope: the operator
    is the one party whose words the agent _should_ act on.
  - A turn that called no tools has nothing in flight, so guidance stays queued
    for the next one instead of being dropped.

  Absent, the loop is byte-identical to before.

- 1500973: Every driver that cannot think now says so instead of dropping the request.

  `thinking` sits on `ChatCompletionParams`, so every driver accepts it. Five of
  them — Bedrock, OpenRouter, HTTP, Ollama, LM Studio — implemented none of it
  and dropped the field: the caller got an ordinary completion with an empty
  `reasoning` array, which is indistinguishable from a model that simply chose
  not to reason. The request looked honoured and the answer looked like an
  answer.

  The OpenAI driver already refused instead, with the reasoning written out
  beside it. So the rule had been decided once and applied once, while five
  siblings went on being silent. It moves to `@namzu/sdk` as
  `assertThinkingUnsupported(driverName, params)`, and a new driver now inherits
  it rather than re-deciding it.

  The error names the driver, which in a multi-provider setup is the difference
  between a bug report about the model and a one-line configuration fix.

  **Turning thinking off stays a no-op** on all of them, because that is the
  state a driver without thinking is already in — a config shared across
  providers saying `{ type: 'disabled' }` should not fail on the ones that were
  never going to think.

  `assertThinkingSupported` in `@namzu/openai` is unchanged as an export and now
  delegates to the shared helper. Its message changed: it no longer says
  "extended thinking", because `adaptive` is refused too and calling that
  extended would be wrong.

  **Migration.** If you passed `thinking` to any of the five and relied on it
  being ignored, remove it — you were receiving a non-thinking answer either way,
  and now you find out at the call instead of by inspecting an empty array.

  Not in this change: implementing thinking natively on Bedrock, which serves the
  same Claude models through a different wire and deserves the per-model
  resolution the Anthropic driver just gained. That needs the Converse request
  and response shapes verified against the reference first, and is not something
  to guess at.

- a2cedfd: Adds `runAgent` — a provider, a model and a prompt is now a complete agent run.

  `drainQuery` is the kernel's entry point and takes eleven required parameters,
  four of which are identity fields that throw when missing. That is the right
  shape for a kernel: a run with no tenant is a run no auditor can attribute. It
  is the wrong shape for the first thing anybody writes, and the proof was
  in-tree — the eval suites, the test files and the CLI each hand-assembled the
  same block, which is what a missing front door looks like from the inside.

  ```ts
  const { output } = await runAgent({
    provider,
    model,
    prompt: "What is 2 + 2?",
  });
  ```

  It supplies an environment rather than a new engine: it generates the session
  identity a single-tenant local run has no opinion about, defaults the budgets,
  and points the working directory at the process's own. Everything it fills in
  is an ordinary `drainQuery` parameter, so there is no second code path — a
  caller who outgrows it passes more options until they are calling `drainQuery`
  in all but name.

  The identity comes back on the result, and that pairing is the point.
  Generating one silently would make each call its own session — right for a
  one-shot and wrong for a conversation, where turn two would start with no
  history and nothing would say so. Spread `result.identity` into the next call
  to continue the same session.

  `model` stays required. `LLMProvider` carries no model — a driver may have been
  constructed with one, but the interface does not expose it, so anything
  inferred here would be a guess billed to the caller.

  Defaults are safe rather than generous, because nobody reads them before their
  first runaway loop: 16 iterations, a 200k token budget, a 5-minute timeout.
  Each is overridable and named on the option.

  The README quick start now shows this instead of a bare `provider.chat()` call
  — that example demonstrated an HTTP client, not the kernel.

## 4.0.0

### Major Changes

- c3cb587: `read`, `write` and `edit` are now contained to the working directory.

  All three called `resolve(workingDirectory, input.path)` bare, so
  `path: "../../.."` reached whatever sits above the working directory and the
  tool used it. No sandbox had to be misconfigured for this — it holds with no
  sandbox at all, which is the common case, so a model that asks for a parent
  directory got one. `resolveWithin` existed the whole time and these three
  never reached it; the search tools (`glob`, `grep`, `ls`) did.

  A lexical check alone would not have been the fix. `atomicWriteFile` resolves
  its destination and writes _through_ a symlink deliberately, so that editing a
  linked file updates the target rather than replacing the link with a regular
  file. Paired with a lexical check that is check-then-follow: a link inside the
  working directory pointing outside it climbs nothing on paper, and the write
  lands outside anyway (CWE-59). Containment is therefore decided after
  canonicalization, which is the ordering CWE-22 states as the mitigation for
  the family: canonicalize, then validate the canonical form.

  Two details the new resolver has to get right, because getting either wrong
  breaks ordinary use rather than failing safe:

  - The root can itself be a symlink — `os.tmpdir()` is one on macOS — so both
    sides are canonicalized. Canonicalizing only the candidate would refuse
    every path under a temp directory.
  - The target may not exist yet, and `realpath` throws on a missing path. The
    deepest existing ancestor is canonicalized and the remainder appended
    lexically; the remainder cannot hide a link because nothing is there to be
    one.

  This does not claim TOCTOU safety. A component swapped for a symlink between
  the check and the open would still be followed — closing that needs
  per-component `openat`/`O_NOFOLLOW`, which Node does not expose. The threat
  addressed is a link that is already present.

  **Migration.** If a host relied on these tools reaching outside
  `workingDirectory` — reading a config beside the repo, writing to a sibling
  output directory — those calls now fail with "Path escapes the working
  directory". Point `workingDirectory` at a root that contains everything the
  run legitimately needs. Sandboxed runs are unaffected: the sandbox has its own
  root and its own resolver, and the host-side canonicalization deliberately
  does not run on that branch.

- a1f67f3: Two allow-lists in the delegation surface stop failing open, and a host can
  now decline a coordinator tool.

  ## An empty delegate roster means nobody

  `create_task` derived its `agent_id` parameter from `allowedAgentIds` but
  widened it from the roster enum to a bare string whenever that roster was
  empty — so the one configuration meaning "this run may delegate to nobody" was
  the only one that let the model name anybody. An allow-list _is_ the
  enumeration of what is permitted; an empty one enumerates nothing and admits
  nothing. Degrading it to an open string to keep functioning is failing open
  (CWE-636), and the rule it breaks is fail-safe defaults (Saltzer & Schroeder
  1975, §I.A.3(b)), restated in NIST SP 800-53 Rev. 5 as SC-7(5) "deny by
  default, allow by exception".

  What that reached is why this is worth a break. The id was not merely rejected
  downstream: it went to the gateway, which resolves against an `AgentManager`
  that is typically **shared**, so an agent the host deliberately left out of
  `agentIds` could still launch if it happened to be registered there. When it
  was not registered, the failure text listed every registered agent id back to
  the model, and the plan row was left stranded at `in_progress` because the
  store write precedes the gateway call while the reconciling update follows it.

  `create_task` is now **not mounted** when the roster is empty, rather than
  mounted with a schema nothing satisfies — refusing per call reaches the same
  verdict while paying prompt-prefix tokens and an iteration for it (NIST SP
  800-53 CM-7, least functionality). It is the only coordinator tool that reads
  the roster, so `agent_task_list`, `approve_plan` and `ask_user_question` are
  untouched: "no delegates, but still planning and a human channel" remains a
  supported configuration. The schema stays closed underneath as defence in
  depth. If you construct a supervisor with `agentIds: []` and expected
  `create_task` to be callable, populate the roster — there is no flag that
  restores the old shape, because the old shape could not correctly succeed.

  `buildAgentTool` carried the identical fallback and now throws at construction
  instead: it returns exactly one tool and that tool _is_ the delegation surface,
  so "do not mount it" and "do not build it" are the same statement. It also
  never checked `subagent_type` against the roster inside `execute`, which is
  reachable without going through the registry; it does now.

  ## A host can decline a coordinator tool

  `runtimeToolOverrides` is this SDK's declared way to decline a kernel-mounted
  tool. It is honoured for the task tools and the advisory tools, and
  `SupervisorAgent` forwards it into its own `drainQuery` call — but it
  registered the coordinator tools before that, unconditionally, so
  `{ create_task: 'disabled' }` was obeyed everywhere except the one surface a
  host would most want to decline. A run that must not delegate had prompt text
  and a gateway refusal as its only defences. This half is pure gap-closure: the
  mechanism, the type and two other call sites already existed, and coordinator
  registration now uses the same idiom.

  ## Collisions refuse instead of overwriting

  This half is new policy, not a gap-closure. Registration now throws
  `ToolNameCollisionError` (exported, carrying `toolName`) when a coordinator
  tool's name is already registered on the supervisor's `tools`, instead of the
  registry's warn-and-overwrite. The reserved names are `create_task`,
  `agent_task_list`, `approve_plan`, and `ask_user_question` — grep for those
  four.

  The old behaviour was not "the host's tool quietly loses and the run works".
  `registerOne` ends by setting availability, and the coordinator call passed
  none, so a tool the host registered `deferred` or `suspended` was silently
  promoted to `active` under someone else's implementation; and because the
  backing store is a `Map`, the replacement inherited the host's insertion
  position in the prompt-cache prefix. That is a different authorization surface,
  not a lost registration — detection of an error condition without action
  (CWE-390), where CWE-694's own mitigation is nearly this fix. Complete
  mediation is the principle (§I.A.3(c)): a registry entry is a remembered
  binding of a name to an authority, and rebinding it leaves every decision made
  about the old binding stale.

  To migrate: rename your tool, or keep your name and decline the coordinator one
  with `runtimeToolOverrides: { "create_task": "disabled" }`. The error names
  both routes.

- df07db8: Removes `ToolCatalogSurface` and `ToolsetPolicy.surfaces`.

  Both were deprecated in 3.2.0 and shipped deprecated again in 3.3.0, so the
  window SemVer asks for — at least one minor release in which working code
  compiles and warns — has been served twice. The deprecation said "slated for
  removal in the next major"; this is that major, and letting it pass would move
  the promise to 5.0.0.

  Nothing produced or read either one. No code constructed a member of the
  union, and `surfaces` was the only field carrying it and was never consulted,
  so there is no runtime behaviour to change and no working code to migrate:
  setting it did nothing before and the field is gone now. Under this repo's
  release rule that is the case where a removal may go straight to major, and it
  is being said here as that rule asks.

  It was also the wrong axis. Which tools a run may use is already expressible
  four ways, all per-run and dynamic where this was fixed at definition:
  `allowedTools` on the query, `ToolAvailability` (`active` / `deferred` /
  `suspended`) with mid-run activation, `runtimeToolOverrides`, and capability
  negotiation stripping tools a driver cannot carry. If you set `surfaces`,
  `allowedTools` is the replacement — it says the same thing per run.

  `SharedRunWorkspace` is unchanged and stays exported without an SDK-side
  caller. That is deliberate and now documented on the class: its config asks for
  a host filesystem root and the path an agent will see, which is a deployment
  shape the kernel does not own. `runtimeRoot` and the paths `refs()` derives
  from it are the contract.

- 19f390a: A delegated agent's output is now framed as untrusted material, and the
  framing itself can no longer be forged.

  **Why the child→parent return.** A delegated worker is the component most
  likely to have consumed something nobody in the run authored: it was handed a
  task like "read these files and report", it ran `read`, `grep`, possibly a
  connector fetch over material the user did not write, and its final text
  landed directly in the parent's context — where the parent typically holds a
  broader tool grant than the child that produced the text. An unlabelled block
  there reads as the parent's own reasoning. Connector-supplied prompts already
  got this treatment; the delegation surface had none.

  `create_task` and the `Agent` tool now wrap their `output` in a
  `<namzu-untrusted kind="agent-result">` frame naming the agent and task, with
  one line saying the content is material rather than direction. The worker's
  text is unaltered inside it, and `data.result` carries it verbatim, so a host
  reading the result programmatically is unaffected — only the model-facing
  string changed.

  **The framing was forgeable, and that is fixed.** The existing envelope around
  connector prompts built its tag by hand and interpolated remote text straight
  into the body. A prompt whose content contained `</mcp-prompt>` closed the
  block early, and everything the server wrote after that read as unlabelled —
  which is to say, as this agent's own instructions. The label was the entire
  mitigation and the labelled party could remove it. `wrapUntrusted` now defangs
  the delimiter case-insensitively (a model reads `</NAMZU-UNTRUSTED>` as the
  same tag) and escapes attribute values, so a source name carrying a quote
  cannot rewrite the tag it appears in.

  Two decisions worth stating because the obvious alternatives are wrong:

  - **No length threshold.** Skipping short payloads to save tokens leaves the
    cheapest carrier unframed; an instruction fits in a tweet.
  - **No "already wrapped, skip it" fast path.** That check is forgeable —
    content merely beginning with the opening tag would pass through with no
    framing at all. Wrapping twice is harmless; not wrapping once is not.

  `wrapUntrusted`, `neutralizeEnvelopeDelimiter` and `UntrustedEnvelope` are
  exported, so a host surfacing its own untrusted content to a model can use the
  same framing rather than inventing one.

  **Migration.** If you assert on `create_task` or `Agent` output text, read
  `data.result` instead — it is the worker's text with nothing added. If you
  call `renderPromptMessages` directly, its output opens with
  `<namzu-untrusted kind="mcp-prompt" …>` rather than `<mcp-prompt …>`.

### Minor Changes

- 2b9d90e: `edit` can do the thing its own description tells the model to do.

  The tool description says _"For insertions, pass insertLine … use `insertLine: "end"` to extend a file at the end"_, and `write-file` and `bash` point at the same idiom. But `modelInputSchema` advertised only `path`/`old_string`/`new_string`/`replace_all` with `additionalProperties: false`, and `enforceModelInput: true` — so under constrained decoding the append idiom the prompt recommends was the one idiom a model could not emit. A consuming host measured the result over seven days on one tenant: **94 of 159 tool failures** were `edit` rejecting an `insertLine` whose spelling the model had guessed.

  `insertLine` is now in the model-facing schema as `oneOf: [integer ≥ 0, "end"]`. Declaring the union that way also removes the synonym problem at its source: for a provider that constrains generation, `"EOF"` is not emittable, because `"end"` is the only string the schema admits.

  `old_string` leaves `required`, because an insert has no text to match — requiring it is exactly what made the idiom unexpressible. Which of `old_string` / `insertLine` is present is decided by the two refinements the execution schema already carries. That is deliberate over a top-level `oneOf`: strict structured-output modes are least surprising with a flat object, and a discriminated union at the root is the construct most likely to be rejected or quietly ignored. The cost is that an incomplete call is now expressible and caught at execution rather than generation — paid knowingly, since the alternative is a working capability nothing can reach.

  For providers that do **not** constrain, `insertLine` also accepts `eof`, `append`, `last` and `end_of_file`. Liberal at execution and strict in the schema is the right way round: none of those is ambiguous, and refusing one bought strictness at the price of a full model round trip. The rejection message now names the value it received.

  Also here, same file family: **`write` refuses a whitespace-only path**, which `edit` has always refused. `.min(1)` admits `"   "`, which resolves to the working directory and fails as an unreadable directory-write error. Two mutating tools disagreeing about the same input is the kind of gap a model finds and a reviewer does not.

- 4be54ca: Three sandbox and delegation gaps, all of the same kind: something declared,
  threaded through types, and never driven.

  **`SandboxExecOptions.signal` now works — on the backend where it can.** The
  option was declared, documented and exported, with a docstring stating that
  without it "a Stop could only ever abandon the _wait_ — the sandboxed process
  kept running after the host believed the run had been cancelled". Every
  backend dropped it, so that is exactly what happened. The local sandbox now
  merges the caller's signal with the call's own deadline and hands the result to
  `spawn`, so the child actually dies; a cancelled run is no longer reported as
  `timedOut`, because a run someone stopped did not run too long, and telling the
  model otherwise invites a retry with a bigger budget.

  The remote backends still ignore it, now explicitly and with the reason in the
  source. Their wire has no cancel op, so aborting the request would abandon the
  wait while the command kept running — the original failure, wearing the
  appearance of a fix. `SandboxExecOptions.signal` documents which backends
  honour it.

  **`ls` respects the sandbox.** It read the host through `node:fs` and named
  `context.sandbox` nowhere, in the one builtin whose whole job is telling the
  model what exists — so under a container or microVM backend the model's picture
  of the filesystem was the host's. Its paths were host-relative too, while
  `read`, `grep` and `glob` all resolve inside the sandbox, so an ls-to-read
  handoff either failed or opened a different file than the one listed. `glob`
  had the identical defect, was fixed, and its fix notes that "every sibling
  builtin already remembers this branch"; this was the sibling that did not.

  One behaviour difference worth knowing: inside a sandbox, directories are
  derived from file paths, because `listFiles` reports files. An empty directory
  is invisible there.

  **The `Agent` tool's header described a design that no longer exists.** It told
  readers to prefer `Agent` because `create_task` was a non-blocking trio driven
  by notification callbacks. `create_task` blocks and returns the worker's output
  as its own result, and `continue_task` / `cancel_task` are not registered at
  all. The two tools are separated by how much of the coordinator surface they
  bring, not by timing.

## 3.3.0

### Minor Changes

- 635ffa9: A human's approval now crosses the spawn boundary.

  `BaseAgentConfig` carried no resume handler. `SendMessageOptions.configOverrides` is a `Partial` of it, so a parent could not hand its decision channel to a child **at the type level** — and no runtime path could carry one either. Every delegated child fell through to the SDK's `autoApproveHandler`, however carefully its parent had been wired.

  **What that cost, exactly.** A `VerificationGate` _deny_ still bit inside a child: denials are threaded into the executor and no later approval releases them. What was lost is the **review** tier — every call the gate left undecided reached the resume handler, and for a child that handler auto-approved. So a host running "ask before acting" had a human review `write` at the top level and never see the same `write` issued one hop down. The shipped CLI encodes the workaround as policy: its sub-agent prompt says _"do not ask the parent questions; make reasonable assumptions"_, because a question had nowhere to go.

  `AgentTaskContext.resumeHandler` carries the parent's channel and `AgentManager` stamps it onto the child config — beside the trace parent and the tenant triple, for the same reason: a `configBuilder` is written by whoever registered the agent and cannot be trusted to forward something it was never told about. An explicit `configOverrides.resumeHandler` still wins, so one child can be given a different channel or none. `SupervisorAgent` now puts its own handler on the spawn context; it already gave that handler to its own run and its own coordinator tools, so the two had disagreed — the supervisor paused for a human while the workers it launched approved themselves.

  Absent still means auto-approve. A host that never wired a handler is unaffected.

  The handler is passed as the function itself, which works because delegation is in-process — `LocalTaskGateway` is the only gateway in the tree. A gateway dispatching across a process boundary could not carry a closure and would have to proxy the request onto the parent's event stream and route the answer back by request id. The upward half of that already exists: `wrapChildListener` stamps lineage on every child event the parent sees, and `user_question_asked` / `tool_review_requested` / `run_paused` are already typed events.

- 6015989: A published MCP prompt reaches the model.

  `listPrompts` and `getPrompt` landed on the client and server last release and stopped there: a server could publish prompts, the SDK could fetch them, and nothing ever put one in front of a model. That shipped the protocol half without the consumer half — the same primitive-with-no-driver shape this series exists to remove, created by the fix for it.

  A prompt is now adapted into a tool the model can call, `mcp_prompt_<server>_<name>`, with an input schema built from the arguments the prompt declares.

  **Why a tool and not system content.** Folding a prompt into the system prompt puts remote text in the cached prefix, so every turn pays for it and the cache breaks whenever the server changes its wording — and system position _reads_ as instruction, which is the last thing text from a remote party should read as. A slash command would route through the host's UI, so a headless run could never use one. A tool call is explicit, auditable, passes the same admission policy and `allowedTools` filter as every other capability, and its answer arrives as a `tool_result`, which a model already treats as data returned by something rather than as direction.

  The result is wrapped in an envelope naming the server and the prompt, and saying the content is material to work with rather than instructions. Untrusted content arriving through a tool result is the standard injection surface, and the mitigation that survives contact is saying plainly whose words these are. A server that returns an `assistant` message has that role reported inside the envelope, never turned into an assistant turn in the run's own history.

  Prompts pass the **same admission policy** as tools, via a shared name check — a server publishing a prompt is the same trust question as one publishing a tool, and two copies of an allow/deny rule are two chances for one to drift permissive. They are namespaced apart from tools, since a server may publish both under one name and collapsing them would let whichever registered second replace the first.

  A fetch that fails is returned to the model rather than thrown: a read-only lookup that a server cannot answer is something an agent can work around, and ending the run over it is the wrong trade.

### Patch Changes

- 82888c6: One `chat` span per model call, not two.

  3.2.0 shipped a second `chat {model}` span. `stream-turn.ts` already opened one — with the same justification, that `chatSpanName` had no call sites — and 3.2.0 added another beside it, same name, same parent, both carrying token counts. A consumer summing spans double-counted latency and tokens.

  Verified by execution rather than by reading: one scripted model call produced two `chat mock-model` spans, both with `gen_ai.usage.input_tokens`.

  The one added in 3.2.0 is removed and the earlier one kept, because it is strictly better — it wraps the call itself and records time to first delta, which the later one did not.

  **How it shipped, since that matters more than the fix.** The search that concluded "zero call sites" covered `telemetry/attributes.ts` and `constants/telemetry/` and never the runtime. Then the test asserting `toHaveLength(1)` failed with `2`, and the failure was explained away — attributed to a forced-final turn — and relaxed to `>= 1`. That relaxation is now reverted to an exact count, and a mutation confirms it catches a re-introduced duplicate as well as a removed span. The reasoning is recorded next to the assertion so the next person to see it fail with `2` reads the history instead of re-deriving the same wrong explanation.

  Reported by a consuming host reading 3.2.0 against its own telemetry.

## 3.2.0

### Minor Changes

- 480892a: Context reduction is a real seam now, and `strategy` has three behaviours instead of two.

  `compactionConfig.strategy` accepted `'structured' | 'sliding-window' | 'disabled'`, and the runtime asked one question about it: is it `'disabled'`. So `'sliding-window'` — the value a host picks precisely to avoid paying for summarization — ran the full structured pass, LLM verification call included. The config lied, and it lied in the direction of spending money.

  `'sliding-window'` now trims: it keeps the recent turns, drops what precedes them, and summarizes nothing. Every survivor is verbatim. For an agent whose state lives outside the transcript — a task queue, a file it keeps editing, a working-memory block the host renders each turn — the paraphrase was only ever cost.

  **A host can also supply their own.** `query({ contextReducer })` takes a function: messages and why it is being asked (`'threshold'` — the estimate says the window is filling; `'overflow'` — the provider already rejected the prompt), returning the shorter history or `undefined` for "I cannot shorten this". It may be async, so a reducer can call a model of its own. A reducer outranks the strategy and fully owns reduction for that run; the structured pass does not also run, because two mechanisms editing one history in the same pass cannot both be reasoned about.

  Three ways a reducer's answer is declined, and the third is the interesting one. `undefined` is the reducer itself declining. A throw is treated as the same answer and logged — a broken reduction hook should not kill a healthy run, the same way a broken `prepareStep` does not. And a result that leaves a `tool_result` without its `tool_use` is **refused rather than repaired**: installing it would trade a nameable "your reducer split a tool pair" for an opaque provider rejection a call later, with the reducer never implicated.

  The built-in reducer keeps the three invariants the type documents: the leading system floor stays, tool pairs stay together, and messages marked `retain` survive. Where no cut below the requested window is safe it takes one above rather than declining — in a multi-step turn every boundary lands on an assistant or tool message, so declining there would fail exactly when the history is longest.

  `ConversationManager`, `createConversationManager`, `SlidingWindowManager`, `StructuredCompactionManager` and `NullManager` are **deprecated** and still exported. That interface cannot be implemented correctly: `reduceContext` is documented as reducing the history but takes `Message[]` and returns `boolean`, so the only way to honour it is in-place mutation — and neither shipped implementation does. Both build a shorter array locally, discard it, and return `true`. Nothing in the runtime ever called any of it, which is how an unfulfillable contract survived this long. Use `ContextReducer`.

- 480892a: Deprecate `ToolCatalogSurface` and `ToolsetPolicy.surfaces`.

  Neither does anything. No code constructs a member of the union, and nothing reads the field that carries it — setting `surfaces` on a toolset policy has no effect and never had one.

  It is also the wrong axis. Which tools a run may use is already expressible four ways, and all of them are per-run and dynamic where this is fixed at definition time: `allowedTools` on the query, `ToolAvailability` (`active` / `deferred` / `suspended`) with mid-run activation through tool search, `runtimeToolOverrides`, and capability negotiation stripping tools a driver cannot carry. `allowedTools` says the same thing, per run.

  The member names — `chat`, `managed-agent`, `worker` — encode deployment shapes this kernel does not own, which is the deeper reason not to keep them. A host's surfaces are the host's to name.

  Deprecated rather than removed because both are reachable from the published typings, so removing them is a breaking change. They go in the next major. This is the deprecation cycle the release policy asks for: a version where the code still compiles and warns.

- beacf2d: Three things the model or the host was invited to say, and the kernel discarded.

  **Plan step dependencies.** `approve_plan` shows the model `depends_on` on every step, described as "Step descriptions this depends on", and then passed `dependsOn: []` for all of them. The declared ordering was dropped at the one place it entered the system. The visible cost is not scheduling — `PlanManager.getNextPendingStep` holds the dependency gate and currently has no callers — it is the **approval**: `dependsOn` is serialized into the `plan_approval` payload a human reads before saying yes, so a reviewer was shown a plan whose steps all looked independent however carefully the model had ordered them.

  Descriptions now resolve to step ids, matched case- and whitespace-insensitively because a model does not reproduce its own strings byte-for-byte. Four things are **refused rather than dropped**, each with the offending text named so the model can correct it and call again: a dependency naming no step, one that two steps could answer, a step depending on itself, and a cycle. The cycle check matters most — no step in a loop can ever start, so the plan does not error, it simply stops making progress with nothing to observe. A diamond is not a cycle and is accepted.

  **Advisory context.** Two paths reach an advisor. The trigger path always passed the live messages, working state and tool catalogue. The tool path — the one the _model_ uses — passed `{ messages: [], iteration: 0 }`, a literal empty context. So an advisor the model consulted about a situation could not see the situation, and the model's own `include_context: true` had nothing to include. The runtime now supplies the live context through a provider function, read at call time rather than captured at construction, because the tool is built once per run and called at an unknown later point.

  That is also where `AdvisoryConfig.includeToolCatalog` and `AdvisorDefinition.useCompactedContext` are read for the first time. Both were declared and consulted by nothing, so a host who turned the catalogue off still paid for it in every advisory prompt.

  **Advisory urgency.** `urgency` reached exactly one debug log line, so `'high'` and `'low'` produced byte-identical requests. The advisor is now told, because it is the party that can act on it — one sentence rather than a routing policy this kernel has no business inventing. `'normal'` appends nothing at all: a sentence asserting the ordinary case is prompt weight that changes no answer and makes the two that matter harder to notice.

- e1a5e2d: The MCP admission boundary is on the path a real server takes.

  `MCPToolDiscovery` has held two checks since it was written: a per-server allow/deny policy deciding what a server may contribute, and detection for a server whose tool set changed since it was last seen. It was implemented, tested and publicly exported, and **nothing outside its own tests ever constructed one**.

  `PluginLifecycleManager.attachMCPServer` — the only code in the tree that connects a real MCP server — called `client.listTools()` and registered whatever came back. So the remote side decided what entered the agent's tool registry, which is least privilege inverted at the one place it matters. Tools land as `deferred` and a run's `allowedTools` filters the model-visible catalogue, so this was never "arbitrary tools reach the model immediately" — but the check written for exactly this was not consulted.

  `PluginLifecycleManagerConfig` takes `mcpToolPolicies` and `onMCPToolDrift`, and discovery now runs through the boundary. Passing neither admits everything, exactly as before: adding a boundary must not turn a working plugin into a broken one.

  **Drift is keyed by server name rather than client id, and that is what makes it fire at all.** A client id is minted per connection, so on the path a real server takes — a plugin enabling, connecting, being disabled, another enabling — every discovery was the first that id had ever seen and drift could not fire however many times the server changed underneath. The threat it exists for is a server that advertises something benign while a host is deciding and something else afterwards, which is a property of the _server_ across connections. For the same reason a disconnect no longer forgets what a server last advertised: forgetting on teardown is precisely the window that swap uses.

  Drift compares what was **admitted**, not what was advertised, so a tool the policy refuses either way does not raise a warning. A warning that fires for something already refused trains a host to ignore the one that matters.

- b807b0d: MCP prompts, server lifecycle events, and an honest "not here".

  **Prompts.** `MCPPromptDefinition` and `MCPPromptArgument` were declared when the MCP types were written; no client method ever asked a server for one and no server branch ever served one, so a server publishing prompts had them silently ignored. `MCPClient` gains `listPrompts()` and `getPrompt(name, args)`, and `MCPServer` takes an optional `MCPServerPromptProvider` alongside the tool and resource ones.

  Prompts page through the same reader as every other list, which is the point of that reader being generic — a server that pages its prompts does not get silently truncated to page one the way the tool list once was. Required arguments are checked against the prompt's own declaration in the server rather than left to each provider to re-implement or forget.

  The messages a prompt returns are the **server's** composition, carried in their own `MCPPromptMessage` shape rather than the kernel's `Message`. A prompt arriving from a remote server is exactly the untrusted-content case: converting at the boundary is what stops a server's `assistant` message from becoming a claim that this agent already said something.

  **Lifecycle events.** `MCPLifecycleEvent` and `MCPEventListener` were declared beside the prompt types and nothing ever emitted one, so a host learned a server had died by noticing that calls had started failing. `MCPClient.onLifecycle(listener)` emits from the four transitions that already existed and already mutated `status` — no new state, the client just says out loud what it already knew. It returns an unsubscribe, which `onNotification` does not: a listener that cannot be removed keeps a disposed host object alive for the life of the client. A listener that throws is logged and the rest still run, because these fire from inside transport callbacks and an escaping exception would surface as a connection error, blaming the server for a bug in the host's observer.

  **"None" and "not here" are different answers.** `resources/list` returned `{ resources: [] }` when no provider was configured, for a capability `initialize` never advertised — telling a client, in the protocol's own vocabulary, that the answer is "none" when the truth is "this server does not do that". The two send a client in opposite directions: one stops asking, the other looks elsewhere. Unimplemented methods now answer with the protocol's method-not-found code via the exported `MCPMethodNotFound`, while a provider that throws still reports an internal error — a broken provider is not an absent feature, and collapsing them tells a client to stop asking for something that works tomorrow.

- 9d2b927: The model call has a span.

  There was none. `chatSpanName` shipped in the telemetry attributes with zero call sites, so a run's traces carried no LLM latency at all — and the one thing anybody opens a trace to find, which turn was slow and why, was the one thing not in it. The token counts landed on the iteration span, one level above the operation that spent them.

  Each model call now opens `chat {model}` under its iteration span, parented explicitly because the loop body is an async generator and the ambient context at resume time belongs to the consumer, not to whoever created the run span.

  It carries the request as sent — operation, provider, model, temperature, max tokens — and, once the turn settles, what came back: response model, response id, input and output tokens, the finish reason as an array per the convention, and cache read/write tokens. `RESPONSE_MODEL`, `RESPONSE_ID`, `REQUEST_TEMPERATURE`, `REQUEST_MAX_TOKENS`, `CACHE_READ_TOKENS` and `CACHE_WRITE_TOKENS` were all declared constants that nothing ever set.

  The span closes on every path, including one the call threw on, using the same `finally` the iteration span now uses — with the duration still measured at the successful close so a healthy turn is not reported as lasting the whole iteration.

  The iteration span keeps its own token attributes rather than having them moved. Something may already read them, and with one turn per iteration the two agree.

- 7370f6d: An OAuth2 connector no longer reaches the upstream unauthenticated.

  `'oauth2'` was grouped with `'none'` and `'custom'` in the HTTP connector's header resolver, returning no headers. Every other auth type throws on a missing credential; this one quietly did not, so a connector configured for OAuth2 sent its request with no credential at all. The upstream's 401 then reads as a bad token rather than as no token, which sends whoever is debugging to look at the token.

  An access token supplied in `credentials.accessToken` (or `token`) is now sent as a bearer. Without one the connector **refuses**, naming what is missing.

  The token exchange itself is deliberately not implemented here: a client-credentials or authorization-code flow needs a token endpoint, refresh handling and somewhere to keep the result, none of which belong in a request-header helper. What is supported is the case a connector config can express today — a token the host already holds.

  `'custom'` keeps returning nothing, and that is not the same omission: it means the host attaches its own headers, so there is nothing to leave out and nothing to refuse.

  **Three connector declarations are now documented as not consulted** rather than left to be discovered. `ConnectorTrigger` and `ConnectorDefinition.triggers` are declared and unimplemented — no inbound event starts a run — and the note says what the missing half actually needs: cross-process de-duplication of a retried webhook, which requires a compare-and-set claim that this repo's only durable write primitive (an atomic file replace, last-writer-wins) cannot express, plus a release path so a claim held by a process that dies does not drop the event forever. It also names the two existing pieces to reuse rather than rebuild. `ConnectorMethod.outputSchema` is unread, with a pointer to how the tool layer already solved the same problem. `ConnectorDefinition.supportedAuth` is unchecked, with a note that the right place to check it is instance creation, not request time.

- ea2148c: A step can put a skill in front of the model.

  `PrepareStepResult.skills` renders the named skills into the same ephemeral trailing system message `system` already uses. A run's skills are fixed at `query()` time and rendered into the cached system prefix, so every skill a run might ever need is paid for on every single turn — and a phased agent rarely needs them all at once. Research wants the search skill, writing wants the style guide, and neither benefits from carrying the other.

  Appending rather than rewriting is the point: the run's own prompt stays byte-stable, so the cached prefix survives, where folding a phase's skills into it would invalidate the cache every iteration.

  It is **additive** to the run's skills, not a replacement. A skill a run always carries should not be removable by a step naming a different one — that would make every step's list a complete restatement, and a phase that forgot one would silently lose it.

  **Sub-agents are deliberately not per-step.** A peer runtime resolves instructions, model, tools, skills and subagents from context at run time; this closes the fourth of those and states why the fifth stays out. Which agents `create_task` can reach is baked into that tool's input schema, so varying it per step would rebuild the tool catalogue every turn — a worse prompt-cache trade than moving tools around, for a narrowing a step can already express by withholding `create_task` through `activeTools`.

- 480892a: A step can force the model's tool use, and the force cannot outlive that step.

  `PrepareStepResult.toolChoice` accepts `'required'`, `'none'`, or a named function. Until now the loop set `tool_choice` only internally, only to `'none'`, and only on the forced-final turn — so a caller could narrow _which_ tools a step may reach for, but never make it actually call one. The clearest cost was structured output: the model answers in prose, the loop pays another full billed turn re-prompting, and after the retry limit the run dies — where one forced choice would have produced the object on the first turn.

  **Why it lives on the step and not on the run config.** A forced choice that persists makes the model call a tool, read the result, and be forced again — an agent that cannot stop. Studying how a peer SDK handles this was the useful part: it puts `tool_choice` on persistent model settings and then needs three moving parts to undo it — a tool-use tracker, an opt-out flag, and a reset applied at two separate call sites — with the flag defaulting to on precisely because turning it off hangs the agent. Two other peer runtimes ship no forced choice at all.

  Putting the knob on `prepareStep` removes that failure instead of managing it. The next step is prepared from scratch, so the force cannot carry forward: there is nothing to reset and no flag to get wrong. The loop still keeps the last word — the forced-final turn's `'none'` wins, so a run that must stop can still stop — and a choice is dropped when no tools are registered, because providers reject `tool_choice` sent without a tool list.

  It costs more prompt cache than `activeTools` does: narrowing tools invalidates the tool prefix, moving `tool_choice` invalidates cached message blocks too. That trade is documented on the field so it is paid knowingly, at a phase boundary, rather than by habit.

- 9bbb8be: `allowedScopes` is a trust boundary now instead of a comment.

  `discoverAllPluginDirs` scans two locations — `.namzu/plugins` under the working directory, and the same path under the user's home directory — and they are not equally trusted. A project plugin is reviewable in the repository the agent is working on; a user plugin comes from a home directory the repository's reviewers never see, and a plugin is arbitrary code with hooks into tool execution.

  `PluginRuntimeConfig` has carried `enabled`, `autoDiscovery` and `allowedScopes` for as long as it has existed. Nothing anywhere read any of the three, and discovery scanned both locations unconditionally, so a host who set `allowedScopes: ['project']` got user plugins anyway — from a setting that reads exactly like a boundary.

  `discoverAllPluginDirs(cwd, { enabled: true, allowedScopes: ['project'] })` now honours it. A disallowed scope is **not scanned** rather than scanned and filtered: reading a directory you have been told not to look in is pointless work, and the returned count would disclose how many plugins live there. `enabled: false` or `autoDiscovery: false` discovers nothing at all, and a parsed `PluginRuntimeConfig` satisfies the options type as-is.

  Calling it with no second argument scans both scopes, exactly as before — every existing caller is unaffected, and a caller who opts in gets what the config says.

- 480892a: Ship the driver that picks a run back up in another process.

  Every piece of a cross-process resume already existed. `CheckpointManager` wrote the history, budgets, working state, trace context and any human-decision park; `loadRunState` read them back; `query` accepted `runId` + `resumeFromCheckpoint` and restored all of it — budgets included, so a run recalled at $4.80 of a $5 cap does not come back with a fresh $5.

  Nothing joined them. `resumeFromCheckpoint` had no caller anywhere outside `packages/sdk/src`, so the whole path shipped untravelled: every host was expected to write the same wiring and none did.

  `resumeRun` is that wiring. The division of labour is the one the mechanism already implies — the caller brings what cannot be serialized (the provider client, the tool registry, the sandbox, the working directory), the store brings the state. A snapshot deliberately holds no socket and no open file, so it could never have carried the first half.

  It refuses at both failure points rather than guessing:

  - **No checkpoint** returns `{ resumed: false, reason: 'no-checkpoint' }`. Starting a fresh run here would be a different run wearing a recycled id, with the original's budget reset.
  - **An outstanding park** returns the `PendingDecision` itself, so the host has what to put in front of a person, instead of resuming past a question the run is waiting on. A park with `resolvedAt` already set is an ordinary resume — blocking on an answered one would strand the run permanently.

  `RunStateScope` is exported alongside it. It was internal, so a host calling the already-public `loadRunState` could not name the argument it had to construct.

- 8518b40: A retrieval namespace partitions what a query can see.

  `TenantScope.namespace` and `KnowledgeBaseConfig.namespace` were declared from the start and neither reached storage. Ingestion copied `scope.tenantId` onto every chunk and dropped the namespace; the store filtered on tenant alone. So a partition a host asked for did not exist, and every namespace inside a tenant saw every other one's documents.

  The namespace is now stamped onto each chunk at ingest and matched at search, across all three retrieval modes.

  **An omitted namespace means the default partition, not the absence of a filter.** That distinction is the whole boundary: reading absence as "no filter" is how one leaks, because a caller who never asked for a namespace would then see every namespaced chunk in the tenant — the opposite of what partitioning is for. A caller who genuinely wants everything asks for each namespace it holds.

  This is a behaviour change for existing data. Chunks ingested under a namespace before this release carry none, so they now answer only to a query with no namespace. Re-ingest to place them in a partition.

  `RetrievalQuery.projectId` is **deprecated and documented as not consulted**. No chunk carries a project — ingestion stamps a tenant and a namespace, and `KnowledgeBaseConfig` has no project field to stamp a third from. Wiring one end of an isolation dimension is worse than wiring neither: a query filtering against a value nothing writes returns zero rows, and "no results" reads as "nothing matched" rather than "this scope was never stored".

- 480892a: `taskRouter` now routes something.

  The compaction summary is the only model call a run makes that nobody asked for: it reads the older half of a transcript and writes a paraphrase, and it fires on exactly the long runs where the primary model costs the most. It was hardwired to that primary model. Meanwhile `taskRouter` had been accepted, schema-validated and threaded through four types since it was added, with `resolveTaskModel` exported and never called from anywhere — so a host who pointed compaction at a cheap model kept paying the expensive one, with nothing to indicate the setting was decoration.

  `taskRouter: { compaction: 'a-small-model' }` now takes effect, falling back to `taskRouter.default` and then to the run's model.

  The remaining keys are documented on `TaskRouterConfig` as **not consulted**, which is the point of the change as much as the wiring is. `coding`, `exploration`, `planning`, `verification` and `summarization` describe sub-agent routing; the supervisor already threads the config down to the agent factory, but nothing classifies a spawned task as exploration or coding, and inventing a classifier would put a wrong model behind a right-looking config. `advisory` is deliberately left alone because an advisor already carries its own `model`, and routing would override an explicit choice with a general one. An inert key is worse than an absent one — saying which is which converts a silent lie into a stated limit.

### Patch Changes

- 05b4103: Two timeouts that did nothing, and a recursion limit that was not the one in force.

  **`OllamaConfig.timeout` and `LMStudioConfig.timeout`** were declared with no doc comment and read by nothing — both constructors forwarded the host and the model and never looked at them, so a host that set a timeout waited forever anyway. The wait they exist for is specific to a local server: the process is up, the socket accepts, and the model never answers because it is still loading or the machine is out of memory.

  Both are composed with the caller's cancellation rather than replacing it. The caller's signal is how a run stops mid-generation, and dropping it for a deadline would leave a local model generating after the run that asked for it has stopped. Absent means no deadline, exactly as before.

  The deadline covers the whole request rather than the time to the first byte, because the failure it exists for is a server that accepts and then never finishes — bounding only the head leaves precisely that case unbounded. A zero or negative value is refused at construction, since it would abort every request rather than bound it.

  **`SupervisorAgentConfig.maxDepth` is deprecated** and documented as not consulted. The recursion bound is enforced in `AgentManager.sendMessage` against the manager's own config, and a supervisor receives a manager rather than building one — so a host setting it on the supervisor got the manager's value regardless. For a safety limit that is the worst way to be wrong: the number in front of the reviewer is not the number in force. Set it on `AgentManagerConfig`, where it is read. Tests now pin both halves, so a change that starts consulting the supervisor's copy fails rather than shipping quietly.

- e1a5e2d: A span closes however its work leaves.

  Two sites had the same shape: `end()` called at every exit the author could see. The iteration loop had seventeen of them; the tool executor had three early returns plus a `finally` that opened below them. That makes span closure a rule every future edit has to remember, and it was already broken in both places.

  In the iteration loop, the span was created and then four statements ran before the `try` — attaching the tool parent span, stamping attributes, emitting `iteration_started`, draining pending events. A throw from any of those left the span open. The loop body is also an async generator, so a consumer that abandons it reached no exit at all.

  In the tool executor, `getOrThrow(toolName)` sat outside the `try` that owned the `finally`. The path where a model invents a tool name — the most likely way that throw happens — opened a span and never closed it.

  An iteration span that never ends is a trace that never closes, so the export is incomplete for exactly the run that failed and is hardest to debug from the outside.

  Both now end in a single `finally`. No status or exception recording moved; only the moment of closing.

## 3.1.0

### Minor Changes

- 8b84fdb: Refuse a file mutation computed against a body that has since moved, and stop writing over symlinks.

  Two gaps the restored mutation lock does not cover, both standard practice in file-editing agents and both absent here.

  **Drift between the read and the write.** The lock serializes this runtime's own writers. It cannot see a person editing in an editor, another process, or a second agent run — and an edit computed against a body that has since changed is a lost update whichever of those did the moving. Worse, it was actively misreported: an `old_string` that no longer matched came back as _"not found in file — make sure the string matches exactly"_, which tells the agent its input was wrong when the file changed underneath it, so it retries the same edit against the same moved file.

  `FileReadTracker.recordRead` now optionally takes the body it read and fingerprints it, and `edit` consults that fingerprint when — and only when — its anchor fails to match. An anchor that still matches uniquely is well defined however much changed elsewhere, so a version check on the success path would reject safe edits every time anyone touched an unrelated line; the fingerprint is a diagnosis, not a gate. When the anchor does fail, it separates 'your text is wrong' from 'the file moved', and the second says what happened, that nothing was written, and to read again. A successful edit re-fingerprints, so a second edit in the same turn is not mistaken for someone else's drift. Both the extra parameter and the new `fingerprint()` accessor are optional, so a host that only needs the read-before-overwrite guard keeps its existing implementation and its existing behaviour.

  **Writing over a symlink instead of through it.** `rename` replaces whatever sits at the destination, so committing onto a link path swapped the link for a regular file — the link gone, and every other path that pointed through it left reading stale content. The atomic writer resolves the destination first, so the link survives and its target is updated. A path that does not exist yet resolves to itself.

### Patch Changes

- 8b84fdb: Close the `ask_user_question` contract, and prove the enforcement hint reaches the wire.

  The second half of the same revert. `ask_user_question` lost `.strict()` on both its root object and its option items, along with `modelInputSchema`, `enforceModelInput` and `validationErrorHint`.

  The failure that specifically motivated them is a model serializing `options` — sending `"[{\"label\":\"Board\"}]"` where an array belongs. A model that does it once tends to keep doing it, and the parse error it gets back never says the array was the problem. The closed schema makes a capable provider refuse at generation time, and the recovery hint names the shape to retry with. Without `.strict()` an unknown key was silently stripped, so a misspelled field became a no-op nobody could see.

  The enforcement path is now covered end to end: a request carries `enforceToolInputSchema` naming exactly the tools that opted in, follows the allowed set rather than everything registered, and omits the field entirely when nothing opted in — an empty array would read as "enforce nothing" rather than "nothing asked", and a driver cannot tell those apart. That coverage is what was missing when the producer was deleted and three drivers went on reading a field nothing set.

- ce15b6e: Restore two provider-classification helpers that 3.0.0 dropped by accident.

  `classifyProviderHttpStatus` and `bodySaysContextOverflow` were part of `@namzu/sdk`'s public surface in 2.0.0. Reconciling a long-running branch resolved a conflict in `public-runtime.ts` in the branch's favour, which discarded both exports, and 3.0.0 shipped without them. They are back.

  Neither was removed on purpose and nothing in 3.0.0's notes claims otherwise. They exist for a driver outside this repo that needs the classification the first-party drivers use: a status code alone does not separate a context overflow from an ordinary bad request, and re-deriving that per driver is how classifications drift apart.

  The gate that should have caught this now does. It compares `baseline - current`, so a name that never entered the baseline was invisible to the removal check — it could be added, dropped, and still report "intact", which is exactly what happened. Widening the surface is now a failure that demands the baseline be regenerated in the same commit, rather than a warning that let the baseline go stale.

- 2175f85: Restore the file-mutation safety that 3.0.0 reverted.

  Reconciling a long-running branch with `-X ours` resolved conflicts in the branch's favour, and the branch had been cut before four hardening commits landed on `main`. The result shipped: `edit.ts` and `write-file.ts` went out byte-identical to their shape from before that work, and both modules it depended on were left in the tree with zero importers.

  What came back, with a test that fails without it:

  - **Crash-atomic commits.** Both tools wrote with a bare `writeFile`, so a failure partway through left the destination truncated — the user's own file, in the tool that exists to avoid exactly that. They commit through `atomicWriteFile` again (temp file beside the destination, fsync, rename).
  - **Same-path serialization.** Two concurrent edits to one path interleaved their reads and the second write landed on content the first had already replaced, so one edit vanished and the loser reported `old_string not found` — blaming the model for a race. `withFileMutationLock` wraps both the sandbox and local branches again. For `write`, the lock also closes the gap between the exists-check and the write, which is a check-then-act pair.
  - **Closed input contracts.** `.strict()` was gone, so zod's default silently STRIPPED an unknown key: a misspelled or hallucinated field became a no-op instead of an error. `edit`, `write` and `ask_user_question` reject the unknown again — while still accepting the `oldStr`/`newStr` aliases and `insertLine`, which are declared. Closed is not the same as narrow.
  - **`modelInputSchema` and `enforceModelInput`.** The model-facing schemas are back, and so is the producer: `enforcedModelInputToolNames()` had been deleted, so **nothing** populated `enforceToolInputSchema` and all three drivers that read it were reading a permanently undefined field.
  - **CRLF/LF reconciliation**, so an `old_string` that is right in every visible way still matches a file whose line endings differ.

  Also fixes `atomicWriteFile` on Windows, where it had never run: it fsyncs the directory after the rename, which that platform refuses with `EPERM`, and the error was not caught — so every atomic write failed after correctly writing the file. That sync is best-effort now, and only after the commit has already landed.

## 3.0.0

### Major Changes

- 935b8f3: Retire the declarations that promised behaviour nothing implemented, and implement the ones worth keeping.

  Seven fields were declared on exported types and read by nothing. Each was a contract a host could satisfy and get no result from — the worst kind of gap, because the only signal is that nothing happens.

  **Implemented**

  - `maxToolContentBytes` capped the rich channel of a tool result, and no caller could set it: `ToolingBootstrapConfig` had no such field, so the cap was always `0` and the capping branch was unreachable. It is now settable on `ReactiveAgentConfig` and on query params, and reaches the executor through the same chain `maxToolOutputChars` already had.
  - `AdvisoryResult.warnings` and `.decisions` had two consumers each — the advisory phase folds decisions into working state so they survive compaction, and renders warnings back to the executing agent — and no producer at all. Advisors are now told the convention their answer is read with, and `parseAdvisoryResponse` lifts `<warnings>` / `<decisions>` blocks out of the prose. The contract is appended to a host-written prompt and a persona-assembled one too, not only the default; an advisor never told the convention would have had its warnings silently discarded.
  - `AdvisoryBudget.maxCostPerRun` is enforced before each call against real accumulated spend, and `maxTokensPerCall` clamps the advisor's own response ceiling. Cost is now computed from a new optional `AdvisorDefinition.pricing`, and a run that sets a cost cap over unpriced advisors is **refused at construction** rather than left with a cap that could never be reached.

  **Removed** — declared, never read, and not worth building:

  - `AdvisoryBudget.maxCallsPerSession` and `maxCostPerSession`: the advisory stack is built once per run, so no accumulator outlived one and a per-session cap could only ever be decoration. `maxCostPerCall` went with them — a per-call cap can only be checked after the spend, which is a log line, not a budget.
  - `AdvisoryResult.plan`, `.modelSuggestion`, `.toolGuidance`: no producer and no consumer.
  - `ToolsetDefinition.toolPolicies`: stored on the toolset and never consulted, so a per-tool `{ enabled: false }` override was inert.
  - `SandboxConfig.cleanupOnDestroy`: defaulted to `true` and read by nothing; `destroy()` removes unconditionally either way.
  - `StructuredOutputConfig.enforceToolChoice`: documented a tool-choice mechanism no code implemented.
  - `RuntimeConfig.promptCache`: caching is unconditional at both model calls, and no surface accepts a `RuntimeConfig`, so nothing could set it even in principle.

  Also ports the telemetry provider to the current tracing API — `Resource` became a type with a factory, and span processors moved to the provider constructor — and lifts a run deadline inside the long-document flow test that aborted the run at 5s and read as a broken flow rather than a busy machine.

- 935b8f3: Three controls a caller could set that the runtime then quietly declined to apply.

  - **`toolChoice: 'none'` permitted tool calls on two drivers.** It means the model must not call a tool. One driver mapped it to the wire's "auto" and the other to `{ type: 'auto' }` — both of which say the model _may_. A caller that had forbidden tool use got a request that allowed it, with nothing in the response to say so. The runtime depends on the guarantee: an advisory consultation passes `'none'` so the advisor answers in prose, into a turn where no executor is waiting for a tool call. Both drivers now answer `'none'` by sending no tools at all, which no wire format can misread.

  - **`memoryLimitMb` and `maxProcesses` were dropped by the stronger isolation tiers.** They were applied inside the unconfined tier's branch only, so asking for namespace or profile isolation silently removed the blast-radius caps — a control failing in the one direction nobody checks. They are the same shell builtin on every tier; the stronger tiers now apply them one level in, inside the wrapper they already spawn through, and keep doing their own job. The sibling backend in the sandbox package already refuses per-sandbox controls it cannot enforce rather than ignoring them; this is the same rule, satisfied by enforcing.

  - **`AgentManager.dispose()` cancelled nothing.** It called `cancelAll('' as RunId)`, and `cancelAll` filters by parent run — no task has an empty parent, so it matched nothing, and the next lines cleared the instance map. Every live child was released without its abort controller firing: the work kept running, the budget kept draining, and nothing was left holding a reference to stop it. It now cancels every live child before dropping them. `cancelAll` stays scoped to one parent, which is its actual job.

  `toBedrockToolConfig` and `buildLimitedSpawn` are exported so the mapping and the spawn shape can be asserted directly rather than through a live process.

- 935b8f3: Three public identifiers named a vendor where the code was generic. Renamed,
  and in two cases the naming was hiding a design problem worth fixing.

  **`OpenRouterEmbeddingProvider` → `HttpEmbeddingProvider`** (config type
  likewise). Nothing about the class was vendor-specific: it POSTs to
  `{baseUrl}/embeddings` with a bearer key and reads back
  `{ data: [{ index, embedding }] }` — the shape every hosted embeddings
  service speaks. Only the name and a default host said otherwise.

  `baseUrl` is now **required**. It defaulted to one vendor's host, which
  meant a caller who never named an endpoint still shipped its text to one. A
  default network destination is a decision the caller has to make out loud.
  A trailing slash is now tolerated rather than producing a doubled path.

  **`AgentFactoryOptions.provider`** was `'openrouter' | 'bedrock'` — a closed
  two-member union in a generic factory, naming two specific services that the
  provider registry has never been limited to and that no caller could extend.
  It is now `string`: any registered provider type.

  **`AgentFactoryOptions.bedrockConfig`** is replaced by
  `providerConfig?: Record<string, unknown>`, passed through untouched. The
  old field existed for exactly one service and had no construction site
  anywhere in the workspace.

  **`StorageProviderId`**: the `'anthropic-files'` member is now
  `'provider-files'`.

- 935b8f3: A model-graded judge, and a failed measurement that stops reading as a zero.

  Every scorer in the harness was a pure function over the run, which is what
  makes them reproducible — and what makes them unable to say whether an
  answer is _good_. `containsScorer` can check that a required phrase appears;
  it cannot tell a correct explanation from a fluent wrong one. The dimension
  most worth guarding had no scorer behind it.

  **`judgeScorer`** grades an open-ended answer with a model. Four choices in
  it are deliberate, because each is where these usually go wrong:

  - The **rubric is required**. A judge asked to rate "quality" rates fluency,
    which correlates with little worth measuring and drifts whenever the judge
    model changes. It throws rather than run without one.
  - An **ordinal scale, not a 0..1 float**. Models place a continuous score
    poorly and cluster on round numbers; a short scale against a written
    rubric is a judgement they can make. The default of 4 is even on purpose —
    an odd scale has a midpoint, and a midpoint is where an uncertain judge
    parks.
  - **Temperature 0**, because sampling noise is indistinguishable from a
    regression.
  - **Truncation disclosed in the prompt**, so the judge does not mark an
    answer down for an ending the harness removed.

  A grade outside the scale it was given is an error rather than a clamp: a
  judge that misread the scale did not apply the rubric either.
  `details.judgeTokens` carries what the judging cost.

  **A failed measurement is no longer a measurement of zero.** A judge is a
  network call, so it can fail to answer at all — and scoring that `0` says
  "the run was bad" when the truth is "we do not know". One rate limit would
  turn a green suite red and send somebody hunting a regression that never
  happened.

  - `Score.unavailable` marks a judgement that could not be produced. It is
    excluded from the case mean's numerator **and** denominator.
  - `CaseResult.status` is `'passed' | 'failed' | 'inconclusive'`, and a case
    where every scorer was unavailable is inconclusive rather than failed.
    `CaseResult.passed` remains, true only for `'passed'`.
  - `ExperimentReport.inconclusive` counts them, and `formatReport` surfaces
    that count **above** the failures — it means every number below covers
    less evidence than it appears to.
  - `byScorer` averages each scorer over the cases it actually judged, and
    omits one that was never available rather than reporting it as `0`.

  A run that **threw** still scores zero: that is a real failure of the thing
  under test, not of the measurement.

  Breaking: `CaseResult` gains a required `status`, `ExperimentReport` gains a
  required `inconclusive`, and a scorer that throws now reports as unavailable
  instead of scoring zero.

- 935b8f3: **Breaking:** `ActiveNodeInfo` and `BranchStackEntry`, and the `activeNode` / `branchStack` checkpoint fields that carried them, are removed.

  Both types described where a multi-node run stood — which agent was active, how deep, what each branch decided — and nothing ever wrote either one. `CheckpointManager.save` accepted them as optional `extra` arguments no caller passed, so every checkpoint ever written left both `undefined`, and a resume that consulted them would have found nothing to consult.

  Resuming a fan-out is already covered, and by a general mechanism rather than a topology-specific one: delegation blocks and returns the worker's output as its own tool result, so a delegation is an ordinary tool call whose completion the transcript records — and the crash-resume path that answers already-executed tool calls answers delegations too. A worker that already ran does not run twice. That behaviour is now pinned by tests, so if delegation ever stops blocking, they fail.

- 935b8f3: **Breaking:** three public types that promised behaviour the runtime does
  not have are removed.

  A public type that describes an absent capability is a worse defect than an
  absent type. It reads as a feature, gets designed around, and the discovery
  that it does nothing happens at runtime — usually in the one code path
  nobody exercised until production.

  - **`PluginHookResult`'s `{ action: 'resume' }`** — declared as a hook
    outcome and rejected with "unsupported action" at every one of its three
    consumers: the lifecycle-event applier, the `pre_tool_use` path and the
    `post_tool_use` path. A plugin author reading the union had every reason
    to think a hook could resume something. Nothing could.
  - **`ConcurrencyMode`** (`'throw' | 'queue'`) — no API accepts it, nothing
    calls the lock it was meant to configure, and the `queue` half describes
    a mode that was never built. It promised a choice about concurrent
    invocation where there is exactly one behaviour.
  - **`ToolPermissionPolicy`** and `ToolsetPolicy.permissionPolicy` — written
    once with a constant `'default'` and read by no runtime code. A host
    setting `'always_ask'` on a toolset got no prompt and no error.

  Migration: nothing consumed any of them, so nothing should break. If your
  code sets `permissionPolicy`, delete the field — it never did anything; the
  verification gate (`allow_by_name`, `custom_pattern`, `target: 'args'`) is
  the surface that actually decides. If a hook returns `{ action: 'resume' }`,
  it was already throwing at every call site.

  Kept, and documented instead of removed: `AgentManager.continueTask` /
  `queueMessage` / `drainMessages`. The queue they maintain is read by
  nothing in the iteration loop — the consumer that once drained it was
  removed — so a caller who assumes `continueTask` reaches a running agent is
  filling a buffer only `drainMessages` empties. That is now stated on the
  interface, along with the two mid-run routes that DO work (feedback inside
  a tool result; `prepareStep`'s `system` string). Deleting `drainMessages`
  would have removed the only way a host can pick those messages up and left
  the trap in place.

- 935b8f3: Close every open code-scanning finding

  **Breaking:** `LocalExecutionContext.executeCommand` no longer interprets its arguments as shell syntax. `shell` defaulted to `true`, and spawning with a shell re-joins the command and its argument array into a single `sh -c` string — so every metacharacter inside an argument became syntax. An `args` array reads argv-safe and was not. The default is now `false`; `shell: true` remains available where a caller genuinely wants a pipeline. A consumer passing `"ls -la"` as one command string, or relying on glob expansion without asking for a shell, must now pass `shell: true`.

  **A sandbox timeout is bounded, and an out-of-range one is refused.** The bash tool's `timeout` argument is a number the model writes, with no ceiling of its own, and it reached both sandbox transports unmodified — so a single call could pin a container or a guest for as long as the platform's timer honours. Both transports now refuse a non-finite, non-positive or over-thirty-minute request rather than clamping it: running under a deadline the caller never chose, and never learns about, is the "accepted and silently not applied" failure this codebase treats as worse than not offering the control at all.

  **Seven quadratic-backtracking regexes are now linear scans**, each on a path an attacker can reach: shell output the agent captured, a tenant-supplied connector URL, a host-supplied workspace root, a model completion, and three endpoint strings that cross the same trust boundary. The worst measured over thirty seconds on a single pathological input, on a shared event loop. Three of the seven were not flagged by the scanner — the same pattern, the same boundary — and were fixed with the rest rather than left to be rediscovered.

- 935b8f3: namzu's own vocabulary, everywhere.

  Comments across the kernel explained namzu's design by naming another
  product: "mirrors X's container architecture", "reference: X's
  `normalizePathForSandbox()`", "which is what Y and Z both do", "Claude Code
  uses 2000 for the same reason". Behaviour was correct throughout — this is
  about what the code says it is. A kernel that explains itself by citation
  reads as a reimplementation of something else, and namzu is not one.

  Every such comment now states the reason directly. Where a rule exists
  because a provider requires it, the comment says what the requirement is
  rather than whose it is — which is also more useful, since the same
  requirement usually holds for more than one provider, and a reader who has
  never used the named one can still follow it.

  **Breaking (types only, no runtime behaviour):**

  - `ToolCatalogSurface`: the `'cowork'` member is now `'supervised'`.
  - `ToolSource.skill.type`: `'anthropic' | 'custom'` is now
    `'published' | 'custom'`.

  Both are descriptive metadata with no construction site anywhere in the
  workspace, so nothing internal moved. An external consumer that names
  either value gets a compile error pointing at the line.

  **Deliberately unchanged**, because these are addresses rather than
  borrowed naming: model-id prefixes in the context-window table (data the
  runtime matches against), API-key detection patterns in the guardrail
  presets (a pattern is worthless if you cannot tell what it detects),
  namzu's own provider package names, and the credential-store integration in
  the CLI, whose service name and file path are literally the other tool's.

- 935b8f3: Tool names are validated, and a paged remote catalogue is read to the end.

  **Every plugin-contributed tool name was illegal.** A tool name reaches the
  provider verbatim and the major message APIs accept `[a-zA-Z0-9_-]` up to 64
  characters — but the plugin namespace separator was `:`, so every tool a
  plugin contributed carried a name the wire rejects. Nothing checked: names
  are derived by concatenation at three separate construction sites and none
  validated the result.

  The rejection is a 400 on the **whole request**, not on that tool. Those
  tools are registered deferred, so it fired the moment something activated
  one, with nothing naming the culprit.

  - `assertToolName` runs at registration, where a bad name can still be
    attributed and costs the run nothing.
  - **Breaking:** `PLUGIN_NAMESPACE_SEPARATOR` is now `__`, which renames every
    plugin-contributed tool id — `fs-plugin:mcp__fs__read_file` becomes
    `fs-plugin__mcp__fs__read_file`. A host that names one of these in an
    allowlist, a permission rule or a preserve-list must update it. The two
    changes have to land together: adding the check without the rename would
    refuse every plugin tool.

  One driver had already ratified passing names through untouched, on the
  grounds that a confusing name is "a naming problem to fix in the registry,
  not something to paper over" — which is precisely why the registry has to be
  the one that checks.

  **A paged remote catalogue is now read to the end.** `tools/list`,
  `resources/list` and `resources/templates/list` each sent an empty params
  object and returned the first page — never sending a cursor, never reading
  the one that came back. A server that pages its catalogue contributed only
  its first page: the rest were never registered, never namespaced, never
  advertised, with no error and no warning. Drift detection did not help
  either, since it compared page one against page one.

  The symptom is a model that never uses a tool it was told about, which reads
  as model incompetence rather than a client bug. Both clients — the SDK's and
  the CLI's — now thread the cursor. A server whose cursor never ends is
  refused after 100 pages rather than looping forever or stopping silently,
  since stopping silently is the failure being fixed.

### Minor Changes

- 935b8f3: An answer can cite the document it came from

  Sending a document buys the provider's native handling of it — page structure, built-in OCR, and the ability to say which passage an answer rests on. namzu could send the document and could not receive the third: an answer about a contract arrived as prose, and checking it meant reading the contract again by hand. A citation is the difference between an answer you trust and one you verify.

  `citations: true` on a document attachment asks for them; they come back on the assistant message as `Citation[]`. Opt-in per document, because the provider splits the document into citable units and the answer carries the passages it leaned on — tokens a turn that never wanted a citation should not pay.

  The location is a union — `page`, `char` or `block` — rather than a page number, because providers segment differently and the segmentation is theirs. Flattening all three would invent a page number for the two that have none. Web-search and search-result citations are deliberately dropped: they point at something that was never in the request, so there is no attachment to resolve them against, and a citation the reader cannot go and look at is worse than none.

  Citations ride with the turn that made them, like reasoning blocks, so compaction takes a turn's evidence with it rather than leaving citations pointing at prose that is gone.

- 935b8f3: A finished run can leave something behind

  The SDK could store a memory and could not form one. `MemoryStore` and its disk implementation have been here all along, and the only path into them was the model calling `save_memory` — so a run that worked out a durable fact and never thought to write it down lost it at settle, along with everything the compaction pass had already extracted and structured on the way.

  The extraction was already built: compaction distils the transcript into decisions, discoveries, requirements and failures precisely because a list of facts is worth more than a summary of prose. That structure was serialized into one system message and then dropped when the run ended. `promoteMemory` is called once, at settle, with it.

  A callback rather than a store the runtime writes into — what is worth remembering is a policy question the host owns, and a runtime that decided it would write a row for every run whether or not anything happened. It is called for a failed run too (the approach that failed is exactly what a later run should not pay for twice), it is awaited rather than fire-and-forget (a one-shot process exits as soon as the run returns), and a throw is swallowed and logged, because a memory that failed to form must not retract an answer that was already produced.

- 935b8f3: A host can judge the **answer**, and one agent instance runs one thing at a
  time.

  **`reviewAnswer` closes the verify-then-fix loop.** `stopWhen` is evaluated
  after each step's _tools_ have run, so it had nothing to say at the moment
  the model stopped calling them — the run finalized with whatever it had
  produced. Running the build, feeding the failure back, and letting the
  model try again meant starting a whole new run and re-supplying the context
  the first one had already assembled.

  The reviewer sees the answer and the history, and either accepts or returns
  feedback that becomes the next user turn. Three properties carry it:

  - **Bounded** by `maxAnswerReviews` (default 3), stopping with
    `stopReason: 'answer_rejected'`. The distinct reason matters: without it
    a reviewer that never accepts ends the run on `max_iterations`, naming
    the resource it exhausted rather than the judgement that exhausted it,
    and the reader goes looking for a loop instead of at the reviewer.
  - **Never on the forced-final turn**, which exists to extract a closing
    summary under pressure. Rejecting it would spend budget the run has
    already run out of.
  - **A reviewer that throws ACCEPTS** — the opposite of the safety gates,
    deliberately. Those are asked "is this dangerous", where failing closed
    costs one refused operation; this is asked "is this good enough", where
    failing closed hands the answer back forever and turns every run into a
    loop. One unreviewed answer is the cheaper failure, and the throw is
    logged at `error` so it is never mistaken for approval.

  Shaped after the structured-output re-prompt directly above it in the loop,
  which solves the same problem for one specific judge.

  **The invocation lock now has a caller.** `InvocationLock`,
  `ConcurrentInvocationError` and `acquireInvocationLock` were all defined and
  exported, and no agent ever acquired the lock — so concurrent invocations of
  one instance were not prevented and the error type could not be thrown by
  anything.

  They are genuinely unsafe: `abortController` and `currentRunId` are
  _instance_ state. Two overlapping runs share one abort controller, so
  cancelling either kills both, and the second clobbers the first's run id, so
  a later `cancel()` cancels the wrong run. Neither failure announces itself —
  the first run simply stops, or the wrong one does. A host that wants
  parallelism constructs a second instance, which is cheap; sharing one was
  never the supported shape, it merely was not refused.

  This is the other half of `ConcurrencyMode`, removed earlier in this release
  as an unreachable type promising a `queue` mode that was never built.

- 935b8f3: Any tool can raise a durable pause

  The pause-for-a-human machinery is durable and complete, and it was reachable from exactly four kernel-owned points: the plan gate, the tool-review gate, the iteration cadence, and the built-in question tool. A host-authored tool had no seam to it — the operations that most want their own confirmation with their own wording, a spend, an outbound post, a destructive migration, had to settle for the generic tool-review gate or hand-thread a recorder and a resume callback into a private builder, which nothing in `ToolContext` suggested was possible.

  `context.requestPause({ name, prompt, options })` is that machinery behind one function. The pause is written as a real checkpoint, so it appears on every surface a tool-review park appears on and survives the process dying, and on resume the answer routes back **by name** — several tools pausing in one batch each get their own, and one call may pause more than once.

  The outcome is `answered`, `unanswered`, or `aborted`. Silence is deliberately not a variant of `answered` with an empty selection: a tool that asks "may I charge this card" and reads silence as yes is worse than one that never asked, so the absence of an answer has its own shape and cannot be destructured into consent. An option id the tool never offered is dropped for the same reason.

  `requestPause` is optional on the context, because a host calling a tool directly provides no route to a human.

- 935b8f3: Four places where namzu knew something and told no one.

  **A backoff is now visible.** `withProviderRetry` logged and slept. There
  was no run event, no wire event, and — worse than that — the sole
  production call site never passed a logger, and every warn in the decorator
  is guarded behind it, so the log lines were dead code too. A run could sit
  silent for the better part of a minute between `iteration_started` and the
  next event, or up to the 60s server-directed cap, with no signal and no
  keepalive: a backoff was indistinguishable from a hang, and a host's
  watchdog would cancel a run that was about to succeed.

  A `provider_retry` run event now carries the attempt, the ceiling, the
  delay, the classified code and whether the server asked for it, mapped to
  `provider.retry` on the SSE wire and to a `running` status update over A2A.
  It is emitted **before** the sleep, so the delay it names is still ahead —
  which is also why it rides the stream as a delta-less chunk rather than an
  out-of-band callback: the consumer is blocked inside the provider's
  iterator, so a callback could not reach it until the wait was already over.
  The omission was never principled; `tool_progress` exists to answer "is it
  still working?" and the wire contract justifies the reasoning events on
  exactly the same grounds.

  **Two latency measurements that could not be recovered from the data.**
  `gen_ai.client.time_to_first_token` is recorded at the first delta of any
  kind. namzu streams, so perceived latency is dominated by that number, and
  the one existing latency histogram measures the whole request — it cannot
  tell a fast-first-token long generation from a stalled one, and no host
  could reconstruct the difference in any form.
  `gen_ai.tool.call.duration` records what the executor has measured since
  its first version: the value was already in scope one frame above the call
  site, emitted per call on `tool_completed`, and had no instrument. It
  carries the same attributes as the tool-call counter, so "which tool is
  slow" and "which tool fails" are one query rather than two that cannot be
  joined.

  **`run_failed` carries the classification it always had.** The event was a
  bare string, and the run boundary flattened the throwable into it,
  discarding `code`, `status`, `retryAfterMs`, `retryable`, `details` and the
  cause chain. This was never a missing taxonomy: the provider-boundary
  classifier already walks all of that, so a fully-populated error arrived at
  the boundary and was thrown away one line later — and `toPlatformError`,
  the projection written for exactly this, had no callers outside its own
  test. `run_failed` now carries `failure` alongside `error`; the A2A bridge
  sends it as event metadata (a peer deciding whether to retry needs the
  flag, not prose to pattern-match) and the CLI prefixes the code. Nothing
  had to change at the hundreds of `throw` sites.

  Not fixed, and worth naming: the advisory `on_error` trigger still
  substring-matches. Its input is tool output from the message history, which
  has no structured code to preserve — that needs a tool-side error catalog,
  not this change.

  **The published attribute constants can no longer drift.**
  `@namzu/telemetry/attributes` restated the attribute bags by hand and had
  already lost `GENAI.TOKEN_TYPE`, the dimension that splits the token
  counter by kind. The consequence was narrow — namzu emits through the
  canonical module, so the dimension is on the data regardless — but this is
  the entry point the observability docs steer consumers to, the package had
  no tests at all, and the public-surface verifier only loads the SDK bundle.
  It is now a re-export, with a parity test so a future hand-copy fails
  immediately.

- 935b8f3: Add programmable stop conditions and a per-step record.

  `GuardCoordinator` was the loop's only halt, and it consumes
  `{aborted, totalTokens, totalCost, currentIteration, startTime}` — it never
  sees messages, tool calls or results. So a terminal `submit_answer` /
  `verify_outputs` tool could not end a run: the model had to be prompt-begged to
  stop, with `maxIterations: 200` or the token budget as the only backstop, which
  meant a finished task still burned its whole envelope. "Stop after three steps
  without progress" and "stop when the plan is complete" were inexpressible.

  **`StepResult`** records what each iteration did — model, message id, content,
  tool calls, tool results, finish reason, per-step usage and cost delta, start
  time, total duration and time spent inside tools. Every field was already
  computed somewhere in the loop; none of it was reachable, because neither `Run`
  nor `BaseAgentResult` had a `steps[]`. A host that persisted the returned `Run`
  — the natural thing — permanently lost per-step attribution, and answering
  "which step cost the most" meant correlating raw `RunEvent`s by iteration number
  and diffing cumulative counters.

  - `Run.steps` carries the record, including on a failed run.
  - `onStepFinish(step)` fires as each step completes.
  - `stopWhen` is evaluated **after** the step's tools have run, so a predicate
    sees what they returned. That ordering is what lets a terminal tool end the
    run _after_ executing rather than instead of executing — its output is still
    recorded and still reaches the model's history.
  - Helpers: `stepCountIs(n)`, `hasToolCall(...names)`, `anyOf(...conditions)`.
    Conditions may be async.
  - A predicate that throws is logged and treated as "do not stop": failing open
    leaves the existing budgets in charge rather than killing a healthy run.
  - New `StopReason: 'stop_condition'`.

  `runToolReview` now returns its tool outcomes alongside its decision, so the
  loop builds the step record from what actually ran instead of re-deriving it
  from the messages it just pushed.

- 935b8f3: Durable run state: a parked approval now survives a process boundary.

  A HITL park used to exist only as a suspended `await` inside one process.
  The checkpoint written just before it looked identical to any mid-run
  checkpoint, so nothing in durable state said a human owed the run an
  answer — an approval queue could not be rebuilt, and a serverless host
  could not park a run at all, because the container holding the promise had
  to stay alive.

  - `IterationCheckpoint.pending` records the `HITLDecisionRequest` verbatim,
    plus the answer once it arrives (kept as evidence, not erased).
  - `findPendingCheckpoint(store, scope)` — the read an approval queue is
    built from, in any process.
  - `RunState` + `captureRunState` / `loadRunState` / `parseRunState`: a
    flat, JSON-safe snapshot with a version guard, so a snapshot written by
    one deployment cannot silently half-restore in another.
  - `QueryParams.pendingDecision` applies a decision collected out-of-band to
    the exact tool calls the human was shown. Without it a resumed run
    repaired the unanswered `tool_use` blocks away and let the model
    re-decide, so "yes, delete that row" degraded into "ask the model again
    and hope it asks for the same thing". The decision is ignored (and the
    repair path runs) when the checkpoint's calls no longer match the
    recorded request — consent to one batch is not consent to another.
  - A `pause` decision keeps the park outstanding; every other action
    resolves it. A host that cannot block answers `pause` immediately and
    comes back in another process.
  - Park recording is lazy (`parkRecordDelayMs`, default 250ms) so a
    programmatic handler never pays for it — except `pause`, which is always
    recorded because it means the decision is still owed.

- 935b8f3: Retry works on a wrapped error, and the runtime actually emits metrics.

  **Every error signal is now read across the whole cause chain.** It was read
  off the error handed in, so one layer of wrapping hid it — and wrapping is
  the normal case, not an edge one: a vendor SDK wraps its transport error and
  the runtime wraps again on the way out. A rate limit wrapped **once**
  classified as `unknown`, which is treated as non-retryable, so the retry
  policy was dead for every failure that was not the outermost throwable. A
  socket reset two levels down was likewise unknown — the one class of failure
  where retrying is almost always right.

  Status, transport errno, `Retry-After`, and message text are all searched
  along the chain now, outermost first, with a `seen` set so a cause cycle
  (easy to build by accident when errors are re-wrapped in a retry loop)
  terminates instead of hanging. Precedence is unchanged — status, then errno,
  then message — and an unwrapped error classifies exactly as before.

  **The runtime emitted spans and not one measurement.** Metrics lived in a
  bag a host was expected to construct, and nothing in the workspace ever
  constructed one. Worse, the bag bound its instruments eagerly, so one built
  before `registerTelemetry()` captured the no-op meter and discarded every
  write for the rest of its life — silently, forever, from a line of call
  order.

  - The instruments now live beside the code that records them, and the
    runtime records token usage and model latency per call, tool outcomes per
    call, and run duration per run.
  - Instruments resolve **lazily** and re-resolve when a real provider is
    installed, so registration order no longer decides whether anything is
    measured.
  - One token metric split by `gen_ai.token.type`, not two under two names
    with the second invented — a dashboard aggregating the conventional name
    was getting input tokens only and under-reporting usage by roughly half.
  - Cache reads and writes are recorded as their own token types. They bill
    differently, so a total that hides them cannot explain a bill.
  - Tool calls carry an error type, so a broken tool can be told apart from
    one whose input the model keeps getting wrong.
  - `createPlatformMetrics()` still works and now delegates to the same
    instruments, so host and runtime measurements aggregate instead of
    describing the same events under two names.

- 935b8f3: A delegated run now joins the trace it belongs to.

  Every run started its own ROOT span, including a spawned sub-agent's. A
  supervisor delegating to three children produced four disconnected traces
  instead of one tree — the same defect that made a 20-turn run show up as 21
  roots before iterations were parented, except across the spawn boundary,
  where the delegation structure is exactly what a trace is for.

  `QueryParams.parentSpan` (and `ReactiveAgentConfig.parentSpan`) parents the
  run span when a caller supplies one. The spawning tool passes its own span,
  so a child run lands inside the turn that asked for it:

      tool span → child run → child iterations → child tool spans

  A top-level run with no parent still starts its own root, which is correct:
  it IS the root, and forcing one would be wrong.

  The parent is stamped onto the child config after `configBuilder` runs
  rather than relying on every builder to forward an option it may not know
  about.

- 935b8f3: A conversation with no turn boundary

  Every other seam in this kernel is turn-based by construction: a run has iterations, an iteration sends a complete message list and reads a stream back, and a checkpoint is taken between two of them. That shape cannot describe a duplex session, where input keeps arriving while output is still being produced and "the turn" is not something either side can point at.

  `BidiProvider` / `BidiSession` is a second contract rather than a widening of the first — bending `chatStream` to accept a live input channel would put a half-duplex assumption inside every consumer of the turn-based path in exchange for a duplex path that still would not fit. `startBidiRun` is the loop that runs tools against it.

  Two properties matter here that the turn-based loop never needs. A tool must not block the stream: awaiting one inline would stall the very events an interruption arrives on, so calls start and are not awaited. And an interruption invalidates work in flight: a call still running when the human speaks over the model is abandoned rather than delivered, because a stale answer in a conversation that has moved on is worse than no answer.

  Audio capture and playback are not here — the types carry audio, but the microphone belongs to the host. Neither is checkpoint/resume: a duplex session's state lives on the far side of a socket with no boundary to snapshot at, and checkpoints that cannot restore would be worse than none. The contract ships with a scripted driver, which is how the turn-based path is developed too.

- 935b8f3: Seven places where state, consent or a verdict did not survive the boundary
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
  _before_ the root span is minted because a parent can only be set at
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
  long-lived process hard-stops the run immediately _after_ the human
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
  now decides, while the code still decides what the failure _is_. And the
  plugin manifest accepted `skills` / `connectors` / `personas` with per-type
  caps that enabling then refused wholesale — so a plugin shipping four tools
  and one skill validated clean, installed clean, was persisted as
  `installed`, and contributed zero tools. The refusal moved to load time,
  with the enable-time check kept as a backstop that transitions the plugin
  to `error` rather than leaving a status that says it is fine.

- 935b8f3: The two gaps that were deferred as needing their own design session.

  **A question raised inside a tool is now durable, and the answer reaches
  the tool that asked.** `ask_user_question` parked through the raw handler
  under a synthetic `cp_question_<toolUseId>` id that was never written
  anywhere. The checkpoint did not exist: nothing on disk said a human owed
  this run an answer, the pending-checkpoint lookup could never return it,
  and a remote host could not even _observe_ the question except through the
  in-process callback. Kill the process while somebody is looking at the card
  and the answer could never be applied — the restore path stripped the whole
  assistant turn, discarding work that sibling tools in the same batch had
  already finished, and re-billed the turn.

  The park is now a real checkpoint, with `user_question_asked` /
  `user_question_answered` on the event stream, `question.asked` /
  `question.answered` on the SSE wire, and an `input-required` A2A status —
  the same surfaces a tool-review park has always had.

  The re-entry contract was the deferred half, and it turned out to reuse
  machinery that already exists. A question checkpoint is written
  mid-execution, so it holds the assistant turn with its `tool_use` blocks
  unanswered — the same shape a tool-review park leaves. Re-executing that
  batch is _how_ the asking tool gets re-entered; a carried-answer registry
  is what makes the re-entry return the recorded answer instead of parking a
  second time; and every sibling that already completed is answered from the
  transcript by the crash-resume recovery, so nothing runs twice. An answer
  that does not name a call in this turn is refused rather than delivered to
  whichever tool now holds that slot.

  **The egress policy has a boundary to be enforced at.** Two of its four
  shapes were honourable nowhere: the container backend refused a host
  allowlist outright because it had nothing to filter through, so `deny-all`
  and `allow-all` were the whole spectrum — all or nothing.

  `EgressProxy` enforces the other two. Matching has exactly two forms —
  exact host, and `.example.com` for a domain and its subdomains — and
  substring is deliberately not one of them: `host.includes(entry)` would
  admit `example.com.attacker.net`, and plain suffix matching would admit
  `notexample.com`. A policy that cannot be read denies, because an allowlist
  that fails open is not an allowlist. A request addressed to the proxy
  itself is refused rather than forwarded — found by a test that hung instead
  of failing, which is exactly the shape that failure takes in production.

  `Sandbox.setNetworkPolicy` narrows or widens a **live** sandbox, so "clone
  with a token, then drop to deny-all before running untrusted build scripts"
  is expressible; it was not, because the policy was frozen at provider
  construction. A backend that cannot enforce it throws.

  And `brokeredCredentials` settles where the token lives. Any credential the
  agent needed to reach an allowed host had to be inside the sandbox, in the
  environment, readable by the untrusted code it is meant to be isolated from
  — via `/proc/self/environ`, or via a prompt injection that exfiltrates it
  over the very egress the policy permits. The real value is now held
  host-side and applied at the boundary, scoped per host: a credential
  attached to every request is a credential handed to whichever host the
  agent was talked into contacting.

  One limit, stated rather than hidden: a credential cannot be injected into
  a CONNECT tunnel, because reading those bytes would mean terminating TLS
  with a CA the sandbox trusts — a strictly larger risk than the one being
  mitigated. A workload that needs brokering speaks plain HTTP to the proxy
  and lets it upgrade upstream. The allowlist is enforced on CONNECT either
  way, since the target names the host in clear text.

- 935b8f3: Two findings from a fit-gap against another agent SDK.

  **A tool veto that throws now denies.** namzu has several places that can
  stop a run, and they disagreed on what happens when the check _itself_
  throws: a content guardrail that threw blocked the run — with a comment
  saying why, "safety is unknown" — while a tool veto that threw was skipped
  and the call proceeded. The same policy inverted its security posture
  depending on which surface it was written on.

  An observer probe that throws is still skipped, and that asymmetry IS
  deliberate: an observer was never asked a question, so it has no answer to
  withhold, and taking a run down because a metrics handler crashed would be
  the same mistake pointing the other way.

  The exposure this trades against is real and is the one the guardrail
  already accepted: a buggy veto can refuse every call. The refusal names the
  probe, so it is diagnosable; a wrongly permitted destructive call is not
  recoverable at all. `docs/sdk/architecture/safety.md` now states the rule
  for all four surfaces in one table.

  The old behaviour was pinned by a test that described it and never argued
  for it, under a header pointing at a design document that had since been
  frozen and removed — so the instruction to "update it first" could not be
  followed, and the fail-open kept its ratified status with no surviving
  justification. The pointer now names a document a reader can open.

  **A truncated tool result says what it took with it.** The output budget
  takes `output: string` only, so the rich channel was never bounded — and
  when the text half truncated, the rich half was dropped with it, silently.
  Dropping is right, since the preview is no longer the tool's own payload
  and an image alongside it would be illustrating something the model can no
  longer read. Doing it silently is not: the model saw a preview with no way
  to know an image had ever existed, and reasoned as though the tool returned
  text only. The result now names what went, so the agent can ask for a
  smaller region instead of retrying the same call.

  `maxToolContentBytes` caps the rich channel, and is **off by default** on
  purpose. The right number depends on what a host's tools return and on the
  model's own image budget; inventing one here would either break screenshot
  workflows or be so generous it bounds nothing. Over the cap the channel is
  refused whole rather than trimmed — half a base64 payload is not a smaller
  image, it is a corrupt one.

- 935b8f3: Reclaim context by clearing stale tool output, before summarizing
  destructively.

  Compaction was all-or-nothing: once the threshold hit, every older message
  became a summary and the agent's own reasoning — the decisions, the false
  starts it learned from, the exact wording of a plan — was paraphrased away
  with it. That is a heavy price for a context problem usually caused by
  something much dumber: a handful of enormous tool outputs the agent already
  read, took what it needed from, and moved past.

  `clearStaleToolResults` replaces the OUTPUT of old, large tool results with
  a short placeholder that names the tool and its original size, so a result
  that turns out to still be needed is one tool call away rather than lost.
  It is safe where trimming is not, because nothing moves — the `tool` message
  keeps its position and its `toolCallId`, so `tool_use` ↔ `tool_result`
  pairing is intact by construction.

  It runs first in `runCompactionCheck`; if it gets the context back under
  `triggerThreshold`, summarization is skipped entirely and the history stays
  verbatim. New `CompactionConfig` fields: `clearToolResults` (default
  `true`), `keepRecentToolResults` (3), `minToolResultCharsToClear` (1000),
  `preserveToolResultsFrom`.

  Never clears an error result (the error is what steers the next turn), the
  most recent N results (still in use), or anything below the size floor
  (the placeholder would cost as much). Image payloads are measured by their
  base64 size — a screenshot is the largest thing a tool result can carry and
  exactly the kind of output an agent reads once.

- 935b8f3: Wire up emergency crash-save, and correct the README's claim about it.

  `EmergencySaveManager.attach()` had zero call sites: the handler that writes
  `emergency/<runId>.json` was never installed, so `replay({ fromCheckpoint:
'emergency' })` read a file nothing ever produced — while the README marketed
  "Emergency save on signal" as a differentiator against six competitors and
  stated "there is no reliance on the user remembering to catch signals; the
  kernel does it."

  `query()` now installs the handlers when you pass `emergencySave: true`, and
  removes them when the run settles.

  It is opt-in rather than automatic, which is a deliberate narrowing of the old
  README claim. `attach()` calls `process.on('SIGINT' | 'SIGTERM' |
'uncaughtException')` with handlers that `process.exit()`; a library must not
  seize its host's termination path by default, and an API server has its own
  drain sequence. The manager is also a singleton whose `attach` detaches
  whoever held it before, so under concurrent runs an automatic attach would
  silently make the last-started run the only one ever saved. Both READMEs now
  say so.

  The `namzu` CLI opts in — it owns its process end to end, so Ctrl-C mid-run
  leaves a dump under `.namzu/emergency/` instead of losing the turn.

- 935b8f3: Five fixes where a subsystem reported more than it delivered.

  **A sandbox tier now says what it actually enforces.** The local provider
  reported `id = 'local'` / `name = 'Local Sandbox'` and logged at `info` at
  every detected tier, but the tiers are not equivalent: one installs a
  deny-default, deny-network profile; one unshares namespaces without
  remounting anything, so the child still sees the whole host filesystem; and
  one confines nothing at all. A host that deliberately turned isolation
  **on** got a tier-dependent amount of it under one undifferentiated name,
  and no guard, test or doc anywhere keyed on the weakest tier.

  - `isolationOf(environment)` states per-tier what is enforced —
    `filesystem`, `network`, `process` — deliberately pessimistic. The
    namespace tier reports `filesystem: false`, because a private mount table
    is not confinement.
  - `sandbox.requireIsolation` (also `new LocalSandboxProvider(log, {…})`)
    **throws** when the host cannot supply a control the caller named.
    Refusing is the point: a control that is accepted and then not applied is
    worse than one never offered, because the caller stops looking. Empty by
    default, so best-effort callers are unaffected.
  - Detection now runs the flags it will spawn under instead of checking that
    a binary exists — a host with unprivileged user namespaces disabled
    answers `unshare --version` happily and then fails every spawn. The
    other platform's probe already ran its sandbox for real.
  - The namespace tier also unshares the network, which it previously left
    wide open while the other tier denied it unconditionally.
  - Constructing at the unconfined tier logs a **warning** naming it as such.

  **Compaction stopped measuring the context one turn late.** The provider's
  prompt measurement describes the request as it was sent, so the assistant
  message and every tool result the turn appended fell outside it — and the
  reading was taken verbatim. Separately, the tool catalogue is assembled
  apart from the message array and never entered the fallback estimate at
  all; a 30-tool registry is easily 10-20k tokens of JSON Schema. Both errors
  point the same way, under-count, so the trigger did not jitter around the
  threshold — it sat systematically late, worst on the turns that grew the
  context the most.

  **A remote tool's schema keeps its shape.** `$ref` reached the converter's
  permissive branch and became "anything": no type, no shape. Since that node
  is inherently optional in Zod, a `$ref`'d field the server listed as
  `required` stopped being enforced too — an empty payload validated clean and
  was forwarded to the server instead of being rejected with the hint the
  executor already builds. `$defs` + `$ref` is the default output of several
  common schema generators, so a server that did everything right had its
  main argument shown to the model as `{}`. Local pointers are now inlined
  first (cycles cut at the repeat, dangling and non-local pointers left
  permissive), `allOf` is flattened, and `pattern`, the length and range
  bounds, `multipleOf` and the `email`/`uri`/`uuid`/`date-time` formats are
  carried onto the converted node — shown to the model _and_ enforced. The
  conversion is also depth-bounded: a remote schema is untrusted input.

  **A declared return shape reaches the model, and a structured result is not
  lost.** Servers publish `outputSchema` on a tool listing regardless of
  negotiated protocol revision and it had no slot in the type, so the return
  shape never reached the model at all. It is now carried verbatim —
  shown, never validated — and appended to the description, since no
  provider's tool format has a field for it. `ToolDefinition.outputSchema`
  takes JSON Schema for the same reason. A server that answers with
  `structuredContent` and omits the compatibility text block previously
  produced an EMPTY tool result for a call that succeeded, with no diagnostic
  anywhere; that payload is now serialized into the output, with the raw pair
  available on `result.data`.

  **A tool batch killed part-way through is resumed, not repeated.** Results
  reach the history only when the whole batch settles, so a hard kill lost
  everything that had already come back and the resumed run re-executed those
  calls — for a `write_file` that is waste, for a payment or an email it is a
  second one. Nothing new had to be recorded: the executor already awaits a
  `tool_completed` per tool, inline, and the transcript already persists it.
  `RunDiskStore.readCompletedTools()` reads it back and `executeBatch` accepts
  those results, so an already-executed call is answered from the record
  while the calls that never ran execute for the first time through the
  ordinary executor — every guard and permission check still applies. The
  discriminator is whether the transcript holds any completion for the turn:
  a tool-review park records its checkpoint _before_ execution, so it has
  none and keeps the existing repair, where re-deciding costs only a round
  trip.

- 935b8f3: Show extensions the model call they fire around

  `pre_llm_call` and `post_llm_call` fired directly beside the request and the reply and were handed neither — only a run id and an iteration number. An extension could observe THAT a call was happening and nothing about what it was, so a prompt audit, a redaction pass, or a per-tenant token ledger had no way to do its job from a hook.

  `PluginHookContext` now carries `request` on `pre_llm_call` (`model`, `messages`, `toolNames`, `temperature`, `maxTokens`) and `response` on `post_llm_call` (`content`, `toolNames`, `finishReason`, `usage`). Both are projections rather than the wire objects, so driver-specific parameters do not become part of the plugin contract by accident, and tools appear as names because an audit asks which capabilities were offered, not what their schemas look like.

  Both are read-only and frozen, and the messages are frozen copies. A hook that reshaped the request would change what every later hook sees, making the outcome depend on installation order — shaping a call stays with `prepareStep`, which has one writer by contract.

- 935b8f3: Hook order is declared, and a hook deadline stops holding the process open.

  **Order was install order** — neither declared nor stable, since it depends
  on when each plugin happened to be installed. That is fine for a hook that
  only observes and wrong for one that decides: `executeHooks` short-circuits
  on `skip` and `error`, so a hook that denies a dangerous command only gets
  to deny it if it runs before whatever else stops the chain. A guard that
  fires depending on installation history is not a guard.

  `PluginHookDefinition.priority` — lower runs first, default `100`, ties
  keeping registration order so a plugin that sets nothing behaves exactly as
  before. Convention: guards below 100, observers above. `post_*` hooks still
  unwind, so a guard at priority 1 runs first on `pre_tool_use` and last on
  `post_tool_use` — the wrapping order a guard needs.

  **The deadline timer was never cleared.** `setTimeout` was armed per hook
  invocation and left running after the hook resolved, and an armed timer
  keeps the Node event loop alive. Hooks fire on every tool call and every
  model call, so a run of twenty tool calls left twenty live timers and the
  process could not exit until the last one expired. Nothing failed — it just
  hung, for up to the timeout, every time.

  **`PluginHookContext.signal`** aborts when that deadline expires. The
  runtime stops waiting on a slow hook either way, but without a signal the
  hook never learns it was abandoned: a request inside it keeps a socket open
  and its eventual result is written into a run that moved on.

  **`registerHook(pluginId, hook)`** attaches a hook without installing a
  plugin from disk. Registration was reachable only through `enable()`, which
  loads a manifest and imports modules by path, so a host that wanted one
  in-process guard had to lay out a plugin directory to get it — and this
  class's own tests were reaching into a private map to work around it,
  constructing entries the real path would never produce.

- 935b8f3: A retried invocation can be deduplicated

  A request goes out, the connection drops, the client retries. Without a key that retry is a second full run — a second set of model calls, and a second set of whatever the tools did. The invocation lock does not help: refusing the retry with `ConcurrentInvocationError` is not what the caller wanted either, because they wanted the answer.

  `AgentRunConfig.idempotencyKey` makes a duplicate arriving while the first is still running await it and receive its result — the error included, because both callers asked the same question once and telling one of them something different would make the key a lie.

  In-flight only. A retry that arrives after the first has settled runs again: keeping the answer would turn deduplication into caching, and how stale an answer may be is the host's judgement, not the SDK's. Instance-scoped, like the lock — deduplicating across processes needs somewhere durable to record the key, which is a store the host owns.

- 935b8f3: Widen the message model to content blocks: multimodal tool results, `is_error`,
  and reasoning replay.

  `ToolMessage.content` was `string` and `AssistantMessage` had no slot for
  reasoning, so three separate things died at the provider boundary. Doing them
  as one migration is deliberate — all three need the same widening, and every
  stored transcript, checkpoint and `messages.json` is written in the narrow
  shape, so the cost only grows.

  **Tool results can carry non-text content.** `ToolResultContent` is
  `string | ToolResultBlock[]`, where a block is text, image or document. String
  stays first-class: the common case is unchanged and every existing tool and
  driver compiles untouched. `@namzu/computer-use`'s `screenshot` returned
  ~400 KB–2.7 MB of base64 **as text** — roughly 100k–670k tokens of characters
  no model can decode — so computer use was effectively non-functional; it now
  returns an image block with a short textual description. MCP `image` and
  inline `resource` blocks are passed through instead of being filtered out.

  **Failures are marked on the wire.** The executor computed `isError`, routed it
  to the SSE bridge, the A2A bridge and the TUI, then dropped it at the provider
  boundary — so the model's trained tool-failure recovery never fired. The
  Anthropic driver now sends `is_error: true`, and the value survives the
  executor's result tuple, which previously narrowed to `{toolCallId, output}`
  before the message was built.

  **Reasoning is representable and replayed verbatim.** `AssistantMessage.reasoning`
  holds opaque `ReasoningBlock`s (thinking / redacted, with signature or encrypted
  payload). The Anthropic driver used to rebuild every assistant turn as
  `[text?, ...tool_use]` — precisely the pattern the verbatim-echo contract
  prohibits when a `tool_result` follows — and now emits stored reasoning blocks
  first, signature intact.

  Drivers that cannot express non-text tool results (`@namzu/openai`,
  `@namzu/ollama`) degrade through `toolResultToText`, which renders an explicit
  `[image: …]` placeholder rather than dumping base64 or silently dropping it.

  This is the outbound half. The Anthropic driver does not yet parse thinking
  blocks out of the stream and `ChatCompletionParams` has no `thinking` field,
  so `reasoning` is populated only when a caller supplies it.

- 935b8f3: Make `MockLLMProvider` a scriptable test model that can emit tool calls.

  The mock accepted `{ model, responseText, responseDelayMs }` and emitted 8-char
  text slices. It never yielded `delta.toolCalls`, and `MOCK_CAPABILITIES`
  declared `supportsTools: false`, so capability negotiation stripped the tool
  surface before a request was even built. A consumer writing a custom tool had
  no supported way to test that the agent loop calls it, that its error string
  comes back as a `tool_result`, or that the model retries — and namzu's own
  maintainers hand-rolled **eight** `implements LLMProvider` fakes across seven
  test files to work around it, each re-implementing the delta bucketing and
  `toolCallEnd` framing that `streamProviderTurn` exists to hide.

  `MockProviderConfig` now takes `turns: MockTurn[]`, where a turn carries text,
  tool calls, a finish reason, usage, and failure injection. Tool calls are
  emitted with the frame sequence a real driver produces — per-tool `index`, id
  and name first, then argument fragments, then the block-close signal — so a
  test exercises the real consumer path instead of a shortcut through it.

  - `truncateArguments` reproduces a tool call cut off mid-JSON at `max_tokens`.
  - `error` fails the request with a status (for retry tests);
    `throwAfterChunks` fails mid-stream (for recovery tests).
  - `nextTurn(params, i)` decides each turn from the request that triggered it;
    `onRequest` and `provider.requests` capture what the runtime actually sent,
    so a test can assert on `tools`, `toolChoice` or `cacheControl`.
  - A script shorter than the run repeats its last turn, so a loop bug reads as
    repetition rather than an exhausted-script crash.
  - `supportsTools` / `supportsFunctionCalling` are now `true`.

  The old `responseText` shorthand still works and becomes a one-turn script.

- 935b8f3: Parse reasoning out of the stream, and let a run request extended thinking.

  This completes the reasoning work: the previous release added storage and
  verbatim replay, but nothing populated it. `StreamChunk.delta` carried only
  `content` and `toolCalls`, so the Anthropic driver's `thinking_delta` and
  `signature_delta` events fell through its `default: // ignore` — the blocks
  could not be captured even in principle. Two consequences: the verbatim-echo
  contract was unsatisfiable in practice, and a streaming UI showed a
  multi-second stall with zero events while the model was demonstrably working.

  - `StreamChunk.delta.reasoning` carries fragments bucketed by block index,
    exactly like `toolCalls[].index`, closed by `done`.
  - `streamProviderTurn` accumulates them and attaches the finished blocks to
    the response in **stream-index order**, not arrival order — a provider may
    interleave blocks, and the echo contract is about the original ordering.
  - New `reasoning_started` / `reasoning_delta` / `reasoning_completed` run
    events, wire-mapped as `reasoning.*`. The delta is ephemeral, so the
    transcript records the completed block rather than every fragment.
  - The Anthropic driver handles `content_block_start` for
    `thinking`/`redacted_thinking`, forwards `thinking_delta` and
    `signature_delta`, and closes the block on `content_block_stop`.
  - `AgentRunConfig.thinking` (`ThinkingConfig`) is forwarded on every model
    call. The Anthropic driver maps it to `thinking` and **omits
    temperature/top_p/top_k while it is enabled**, because the API rejects them
    together — sending a request known to 400 is worse than dropping a sampling
    knob the caller did not prioritise.

  Reasoning rides on the assistant message it belongs to, so the replay contract
  holds automatically: trimming or compacting that message takes its thinking
  blocks with it, and no separate atomicity rule is needed in `findSafeTrimIndex`.

- 935b8f3: Add a provider failure taxonomy and retry transient model-call failures.

  No driver in the estate retried anything: a single `429`, `503` or dropped
  socket terminated the run. Nor could one be added, because every driver threw
  its vendor SDK's raw error and the runtime had no way to tell a rate limit
  from a malformed request — classification is the substrate a retry policy
  stands on.

  `ProviderError` gives failures a `code` (`rate_limit`, `overloaded`,
  `server_error`, `timeout`, `network`, `auth`, `invalid_request`,
  `context_length_exceeded`, `content_filter`, `not_found`, `unknown`), a
  `retryable` flag, the HTTP `status`, and a server-directed `retryAfterMs`
  parsed from `Retry-After` (both delta-seconds and HTTP-date forms).
  `classifyProviderError` derives it from status, then transport errno, then
  message text — so a window overflow arriving as a `400` is filed as
  `context_length_exceeded` rather than a generic invalid request, because the
  caller can act on one and not the other.

  `withProviderRetry` wraps any `LLMProvider` with exponential backoff and full
  jitter, honouring `Retry-After` up to a sanity cap. It retries **only before
  the first content chunk**: once a delta has been yielded the consumer has
  already emitted `text_delta` events, so restarting would duplicate output.
  Aborts propagate untouched, so a Stop still settles the run as `cancelled`.

  `query()` wraps its provider by default; pass `retry: false` to opt out, or a
  partial config to tune it. The wrapper is transparent to `id`, `name` and
  `capabilities`, so capability negotiation is unaffected.

- 935b8f3: Make compaction actually fire, and make it observable.

  The trigger divided the current context size by `runConfig.tokenBudget` whenever
  `contextWindowTokens` was absent — which was always, since nothing in the estate
  ever set it. Those are different quantities: `tokenBudget` is a cumulative spend
  cap, and comparing a live window against it is self-defeating, because the guard
  force-finalizes at 0.9x that number while compaction needs 0.7x of it. With the
  shipped CLI's `tokenBudget: 1_000_000` the trigger sat at ~700k. The entire
  subsystem — working state, extractor, serializer, dangling repair, verifier —
  was armed and never fired.

  - The divisor is now always a context **window**: `contextWindowTokens` when the
    host sets one, otherwise resolved from the model id via a new
    `resolveContextWindow` / `lookupContextWindow`, otherwise a conservative
    128k default. `tokenBudget` is never the divisor.
  - Context size prefers the provider's own `promptTokens` from the last turn — a
    measurement that includes tool schemas, system blocks and image tokens — over
    the chars/4 heuristic, which remains the fallback before the first turn
    reports. `RunPersistence.recordTurnUsage()` records it; side-channel calls
    keep using `accumulateUsage()` so they cannot corrupt the signal.
  - Two guards (the thrash guard and prior-summary replacement) were gated behind
    `contextWindowTokens != null` to preserve the legacy path byte-for-byte. That
    path's actual behavior was "never fires", so the gates are removed — otherwise
    a consumer that now compacts would accumulate one redundant summary per pass.
  - New `compaction_completed` run event (wire: `compaction.completed`) carrying
    before/after message counts and token sizes, whether the size was measured or
    estimated, and which window was used. Compaction deletes history
    irrecoverably and previously emitted nothing at all.

- 935b8f3: Let `MockLLMProvider` declare capabilities and fail mid-tool-arguments.

  Two small additions that let the scriptable mock absorb the last of the
  hand-rolled test providers:

  - `capabilities` overrides the declaration for one instance. Capability
    negotiation degrades a run when a driver says it cannot do something, and
    testing that path means being able to _say_ it — a fixed registry-level
    declaration cannot express "a driver with no vision".
  - `rawArguments` emits a raw string instead of serializing `args`, and
    `throwAfterArguments` throws mid-tool-block. Together they script a provider
    going idle while streaming tool JSON, which is precisely the failure the
    truncated-tool-input recovery path exists for — otherwise that path can only
    be tested by hand-rolling a provider, which is what everyone was doing.

  Six of the eight `implements LLMProvider` fakes across the test suite are now
  gone. The two that remain are in `registry.test.ts`, which checks that the
  registry accepts arbitrary provider _constructors_; collapsing those would
  defeat what they test.

- 935b8f3: Persisted state carries a schema version, and a record from the future is
  refused instead of half-read.

  Every read from disk was `JSON.parse(raw) as T` — an unchecked cast with no
  idea which version of the shape it was looking at. Three things followed,
  all of them silent:

  - A record written by an **older** build was read as the current shape.
    Fields added since arrived as `undefined` and flowed into the runtime as
    though they had been there.
  - A record written by a **newer** build was read by an older one, which
    understood some fields and dropped the rest. Write it back and the rest
    are gone — the only one of these that destroys data.
  - None of it produced an error, a warning, or a log line. A resumed session
    that quietly lost half its state looked exactly like one that never had
    it.

  The version is stamped as a field on the record rather than wrapping it in
  an envelope, so **every file already on disk stays readable**: a record with
  no stamp _is_ version 1, which is exactly what those files are.

  - `defineSchema` / `stamp` / `migrate` in `store/schema.ts`, adopted by the
    session, thread, run, task and memory disk stores. Each store versions its
    on-disk format as a unit, so no call site carries schema plumbing.
  - A record from a version this build does not understand throws
    `SchemaVersionError` naming what it found and what is supported. Refusing
    is recoverable by upgrading; a partial read that gets written back is not.
  - A gap in the migration chain is rejected when the schema is **declared**,
    not when a stale file finally shows up — a gap found at read time is found
    in production, by a user whose session will not open.
  - Each line of the append-only message log carries its own stamp: such a log
    is written by many builds over its lifetime and its lines can legitimately
    differ in version. A line the build cannot read is refused rather than
    skipped, because silently dropping one hands the model a conversation with
    a hole in it.

  Known limitation, stated rather than papered over: a file whose top level is
  an array has nowhere to put a stamp that survives `JSON.stringify`, so it
  stays unversioned. A store that needs to migrate one has to move it under an
  object first.

- 935b8f3: `prepareStep` — shape each step before the model is called.

  `stopWhen` let a run decide TO STOP from what its steps produced. This is
  the other half: deciding how the next step should look. Without it, the
  tool surface and the model were fixed at `query()` time, so a phased agent
  — research with search tools, write with file tools, verify with a cheaper
  model — had to be built as three separate runs, each starting blind to the
  last one's context.

  The hook receives the run id, the step number, the full message history and
  every completed `StepResult`, and may return `activeTools`, `model`,
  `system` (one-step guidance), `temperature` and `maxResponseTokens`. Any
  omitted field keeps the run's configured value.

  - `system` guidance is appended to the REQUEST, never pushed onto the run's
    history — otherwise a long run accumulates one stale phase instruction
    per iteration.
  - `activeTools` does NOT touch `tool_choice`. Anthropic has no
    `allowed_tools`, and moving `tool_choice` invalidates cached MESSAGE
    blocks as well — a strictly worse trade for the same effect. Narrowing
    still costs the prompt-cache prefix, since tools render at position 0;
    that is inherent, and worth paying at a real phase boundary rather than
    every step.
  - Unregistered tool names are dropped with a warning: a phase list that
    outlives a tool rename should narrow the surface, not kill the agent
    mid-run.
  - Fails OPEN. A throwing hook leaves the step with the run's configuration
    — same reasoning as `stopWhen`, and deliberately opposite to a guardrail,
    because nothing unsafe gets through when step shaping is skipped.

- 935b8f3: Give runtime failures a code a host can branch on.

  `PlatformError` was declared and never constructed — a shape nothing
  produced and nothing consumed — while the runtime threw bare `Error`
  everywhere. A caller catching a failure from `query()` could not tell "the
  model rate-limited us" from "the run was configured wrong" from "that
  checkpoint does not exist"; matching on message text was the only recourse,
  and message text is not an interface.

  - `NamzuError` implements `PlatformError` and extends `Error`, so it still
    behaves like one everywhere that only knows about `Error` — stack,
    `instanceof`, `cause`.
  - `NamzuErrorCode` stays small on purpose: each member exists because a
    caller does something different about it (`invalid_config`,
    `provider_error`, `tool_error`, `not_found`, `plugin_error`,
    `capability_unavailable`, `storage_error`, `unknown`).
  - `toPlatformError(unknown)` normalizes ANYTHING thrown into the declared
    shape — a `NamzuError`, a `ProviderError`, a plain `Error` from a
    dependency, or a thrown string. Without it, "handle errors from the SDK"
    means writing the same `instanceof` ladder in every caller. A
    `ProviderError` keeps its own classification (its code lands in
    `details.providerCode` and its `retryable` verdict is preserved, not
    recomputed).

  Adopted at the runtime sites a host would actually branch on: strict
  capability failures, provider stream errors, checkpoint-not-found, and
  plugin hook errors. Exhaustiveness guards stay plain `Error` — those are
  programmer bugs, not conditions to handle.

- 935b8f3: Step shaping composes

  `prepareStep` was a single slot: enough for one concern and no help with two. A host with a per-tenant system prefix _and_ a cost-based model downgrade had to hand-compose them into one callback, which puts the ordering in the host's own code where nothing can see it and makes each concern's failure the other's problem.

  It now accepts an array. Stages run in **declaration order** — not registration order, and that distinction is the whole reason this is safe where a plugin-style fan-out would not be: the author writes the order down, so "who wins" is a line of their code rather than an accident of install history. Each stage sees what the ones before it decided through `context.prepared`, which is how a later stage refines an earlier one instead of guessing at it.

  A stage that throws is skipped and the rest still run, because one broken concern must not silently disable the others it was declared beside. A single function behaves exactly as before.

- 935b8f3: Add input/output guardrails to `query()`.

  namzu had three gates on tool calls — probe veto, `VerificationGate`, HITL
  review — and all three point the same way: they protect the world from the
  agent. Nothing protected the user from the agent's own output, and nothing
  looked at the prompt before a run started.

  - `inputGuardrails` run before the first model call. A block settles the run
    as `input_guardrail` having spent nothing.
  - `outputGuardrails` run against the final result. A block settles as
    `output_guardrail`; a `rewrite` replaces the text, so a redaction policy
    can clean an answer instead of discarding it. Rewrites compose.
  - A guardrail that throws **fails closed** — deliberately the opposite of
    `stopWhen`. A broken halt predicate should not kill a healthy run; a broken
    safety check must not wave content through.
  - New `guardrail_triggered` run event (wire: `guardrail.triggered`).
  - Presets: `secretRedactionGuardrail` (prefix-anchored credential patterns,
    redact or block) and `promptInjectionGuardrail` (partial, by design).

  These gate the result, not the stream: `text_delta` events have already
  reached the host, so a rewrite arrives as a correction alongside the event.

- 935b8f3: Make the loop-control surface reachable from the Agent classes, and stop
  gating environment context on built-in tool names.

  Found by auditing the one application in the estate that actually consumes
  `@namzu/sdk`, rather than by reading the SDK again.

  - **`ReactiveAgent` forwarded none of the loop-control seams.** It is what
    `AgentManager` spawns and what real applications call, and it passed only
    provider/tools/runConfig — so `toolTimeoutMs`, `retry`, `emergencySave`,
    `stopWhen`, `onStepFinish`, `prepareStep`, `structuredOutput`,
    guardrails, `repairToolCall`, `maxToolConcurrency`, `maxToolOutputChars`,
    `resumeHandler` and `checkpointStore` were reachable only by dropping to
    `query()` and rebuilding the run wiring by hand. A feature a consumer
    cannot reach is a feature that does not exist for them.

  - **The `<env>` block keyed on four hardcoded tool names.** A host
    registering a filesystem tool called `read_file` — declaring
    `category: 'filesystem'` and `permissions: ['file_read']` correctly — got
    no environment context at all, so the model was never told its working
    directory and the host hand-encoded paths into its system prompt. The
    gate now reads what a tool declares, keeping the name set as a fallback.

  - **Providers were handed the run's live message array.** `runMgr.messages`
    is the live array and the loop pushes onto it after the call returns, so
    a driver that retained its input — to log it, cache it, or replay it on
    retry — watched it grow new turns underneath. A capture provider in the
    estate recorded every turn as identical to the last for exactly this
    reason. The array is now copied at the provider boundary.

- 935b8f3: Five places where namzu gave up, or claimed to recover, too early.

  **A transient failure now pauses instead of failing.** A 503 that survived
  every in-turn recovery — retry with jitter, the one-shot compaction relief,
  mid-stream salvage — settled the run as `failed`, identically to a bad API
  key. The host could not tell them apart, and recovering meant knowing about
  checkpoints and driving replay itself. The state was never the problem:
  checkpoints are written every iteration by default and the failed run is
  persisted with full messages. Only the settle and the signal were missing.

  A retryable failure with a checkpoint to resume from now emits `run_paused`
  naming that checkpoint, leaves the span OK rather than ERROR, and sets
  `stopReason: 'paused'`. Both conditions are required — pausing on a
  permanent error would invite a resume that cannot work, and pausing with
  nowhere to resume from produces a run nobody can ever pick up.

  **A forced compaction pass can no longer decline to do anything.** A forced
  pass runs because the provider _rejected_ the prompt as too long, and two
  things let it treat that as advisory. It re-applied the chars/4 estimate
  after clearing stale tool results — the estimate the provider had just
  refuted — and returned early if that said the context was fine. And relief
  reported success on ANY positive shed, so clearing one short result counted
  and the retry burned a whole model call to be told the same thing. The
  early return is now force-gated, and a shed has to clear a floor (a
  fraction of the prompt, at least a couple of thousand characters) to count.

  Separately, the relief latch is per **stuck point**, not per run. It exists
  to stop a second overflow immediately after a successful compaction from
  looping; as a run-scoped flag it meant one relief at iteration 3 disarmed
  the mechanism for the rest of the run, leaving iteration 40 to die with
  obvious moves left. It is now cleared by a turn that actually succeeded.

  **An eval case can no longer hang the suite.** `executeCase` was a bare
  await, so a `run` closure that never settled blocked its worker and
  `runExperiment` never returned — no report, no partial results, nothing to
  read. `ExperimentConfig.timeoutMs` bounds a case and hands `run` an
  `AbortSignal` as a third argument; a timed-out case is reported and the
  suite continues, exactly like a case that threw, with its real elapsed time
  rather than zero. Unset means no deadline, which is today's behaviour. The
  documented path already inherits deadlines from the runtime it drives; this
  covers what those cannot see — a closure that does not go through
  `query()`, and a mid-iteration provider stall.

  **A malformed content block is named, not smuggled.** One driver built an
  image block by calling `String()` on whatever `data` and `mediaType`
  happened to be, behind only a truthiness check — so a non-string `data`
  became the literal `"[object Object]"` as the base64 payload, and the wire
  rejected the whole request with nothing naming the block at fault. That is
  reachable: a remote tool result is cast without validation on the way in.
  It now type- and media-type-guards and degrades to a named placeholder,
  matching the sibling driver that already did, and without inlining the
  payload it refused to send.

  **Failures have somewhere to grow remediation.** A stale API key surfaced
  as whatever prose the vendor SDK happened to write: no id to grep in logs,
  no instruction on what to change, and no growth point — a newly-observed
  failure shape could only be given curated copy by editing the classifier.
  `explainError` adds an ordered, id-keyed rule layer matching on
  **structural** signals (code, status, an explicit hint) rather than
  volatile vendor prose. `run_failed` carries the result as `explanation`;
  `withHint(err, '…')` lets a throw site attach what only it knows, and
  outranks every generic rule. It returns `null` when no rule claims the
  failure — inventing advice for something uncharacterised is worse than
  saying nothing, because it sends the reader somewhere specific and wrong.
  The container backend's readiness, port-mapping and worker-fetch failures
  now carry hints.

- 935b8f3: A context overflow now shortens the prompt and retries instead of killing
  the run.

  `context_length_exceeded` was classified precisely and consumed by nothing.
  It is correctly non-retryable — resending the identical prompt cannot help
  — so the run died, holding a compaction subsystem that could have made
  room.

  This is not a hypothetical failure. Compaction fires on an ESTIMATE of how
  full the context is, and an estimate can read low: a run carrying images,
  or text in a language the chars-per-token ratio does not fit, reaches the
  real window while still looking comfortable. The provider then reports
  exactly what is wrong, which is stronger evidence than the estimate that
  was just proven wrong.

  - `relieveOverflow` forces a compaction pass, bypassing the threshold.
  - It reports whether anything was actually shed. When nothing was — no
    compaction configured, or nothing left to compact — the error proceeds,
    because retrying would send the same prompt and reach the same error.
  - Relief is attempted once per run. A second overflow after a successful
    compaction means the prompt is irreducible, and looping would burn the
    budget to arrive at the same place.

- 935b8f3: A message can be pinned against eviction

  Everything a run protected from compaction was protected by **position**: the leading system messages, the working-memory slot, the last N turns, the most recent tool results. A standing constraint stated in the middle of a conversation — "the account id is 4471; never bill a different one" — therefore aged out at the same rate as chatter. No positional rule could express it, and the working-memory slot could not either: it is host-rendered each turn and does not know what the user said.

  `retain: true` on a message says it directly. The summarization rebuild carries pinned turns over verbatim, in order, between the summary and the recent window, and the in-place tool-result clearing pass leaves their content alone — clearing keeps the message and replaces its content, which is exactly the loss the marker was asked to prevent.

  Protection is transitive across a tool pair: pinning a `tool_result` pins the assistant turn that issued the call, and pinning that turn pins every result answering it. Half a pair is not a smaller history, it is one the provider rejects.

  Nothing caps how much may be pinned. Pinned turns are exempt from the reclaim that keeps a long run alive, so this is a budget the setter spends — a cap would have to guess which pin mattered, and dropping the wrong one quietly is worse than a run that overflows in the open.

- 935b8f3: Add structured final output — and fix two bugs it uncovered on the tool-result
  wire path.

  **Structured output.** Both leaf pieces already shipped and neither was
  reachable: `createStructuredOutputTool` is excluded from `getBuiltinTools()`
  because it needs a schema, and `StructuredOutputConfig` was referenced by
  exactly one non-test line — the barrel re-export. A host needing
  `{verdict, findings}` from an agent that also uses tools had to register the
  tool by hand and hope: nothing forced the call, nothing stopped the loop when
  it came, and a schema mismatch surfaced as a `ZodError` _after_ the run had
  paid for itself.

  `query({ structuredOutput: { schema } })` registers the tool **from iteration
  zero** — tools render at prefix position 0, so late injection would invalidate
  the prompt cache for the rest of the run — validates the call, lands the parsed
  value on `Run.structuredOutput`, and ends the run there rather than paying for
  another turn that would only restate it. A model that answers in prose is
  re-prompted, bounded by `maxRetries` (default 2), after which the run settles
  with the new `StopReason: 'structured_output_failed'` instead of grinding
  against `maxIterations`.

  **Two bugs found while testing it**, both on the path between what a tool
  returns and what reaches the provider, and both introduced by the content-block
  migration:

  - `ToolExecutor`'s final return omitted `isError`, so a failed tool was never
    marked as failed on the message and `is_error` could not reach the wire.
  - The executor's local `result` was typed as a narrowed literal that dropped
    `content`, so a tool returning an image block had it discarded before the
    mapper built to carry it ever saw it.

  The mapper tests passed throughout because they set those fields by hand. A new
  suite covers the executor→message seam directly, which is where both lived.

- 935b8f3: A fan-out can now declare what a failed child means for its siblings.

  The primitive to stop them already existed — every child holds an abort
  controller chained to the parent's, and `AgentManager.cancel` uses it — but
  nothing connected a failure to it. A supervisor that fanned out five tasks
  and watched one die had no way to say the other four were now pointless:
  they ran to completion, spending budget on work whose premise had gone.

  `LocalTaskGateway` takes a `SiblingFailurePolicy`:

  - `'continue'` — the default, and deliberately unchanged. Partial results
    are usually worth having, and cancelling healthy siblings on any failure
    would let one flaky child waste four good ones.
  - `'cancel-siblings'` — for a fan-out whose parts only mean something
    together, where one dead leg makes the rest an answer nobody can use.

  Failure is judged from the result as well as the task state. A child whose
  spawn machinery threw lands in state `'failed'`, but a child that RAN and
  returned `status: 'failed'` is marked completed and carries the failure in
  its result — so reading only the state would have caught the exceptional
  case and missed the ordinary one.

- 935b8f3: Cap model-visible tool output, and spill the overflow instead of losing it.

  Nothing bounded tool output. `read` returned a whole file when `limit` was
  omitted, `bash` allowed a 100 MB buffer, and the MCP adapter joined every text
  block uncapped — so a `read` of a 2 MB lockfile became ~500k tokens in one
  `tool_result`, the provider rejected the request, and with no retry the run
  died with everything lost. The one existing reducer, `compressShellOutput`,
  early-returns for any tool whose category is not `shell` and has no absolute
  size cap at all.

  - `maxToolOutputChars` (default 40k ≈ 10k tokens), overridable per run. Output
    over budget is written to `<runDir>/tool-output/<toolUseId>.txt` and replaced
    with a head+tail preview naming the path. Spilling beats truncating on every
    axis: nothing is lost, tokens are paid only if the agent decides the rest is
    worth re-reading, and retrieval uses `read`/`grep` — tools it already has.
    Without a run directory it degrades to middle-elision rather than being
    unbounded.
  - `read` defaults to a 2000-line window instead of the entire file, and any
    partial read now ends with a `[PARTIAL view — lines X-Y of Z]` notice naming
    the exact next call. A truncated read used to be indistinguishable from a
    short file, so the agent reasoned about a fragment as if it were the whole
    thing.
  - `bash` surfaces the sandbox's `stdoutTruncated` / `stderrTruncated` flags,
    which were computed by the backend and dropped at the `SandboxExecResult`
    type boundary — the model saw a complete-looking result that had silently
    lost its tail. Both flags are now part of the contract, along with
    `SandboxExecOptions.signal` so a cancelled run can reach the process.
  - `tool_completed` carries `durationMs` (computed since the first version of
    the executor but only ever logged), plus `outputLength`, `outputTruncated`
    and `outputSpillPath`.

- 935b8f3: Compaction's working state now rides the checkpoint, so a resumed run stops
  deleting its own history.

  Compaction replaces older messages with a summary and drops any prior
  `[COMPACTED CONTEXT]` block, on the grounds that `serializeState` is
  cumulative so the newer summary supersedes it. That holds inside one
  process. Across a resume it did not: `WorkingStateManager` was constructed
  fresh on every `query()` with no restore path, so the second compaction of
  a resumed run produced a summary covering only post-resume activity — and
  deleted the block that held everything before it.

  The restore path deliberately carries that block forward, calling it the
  only surviving record of the history the first pass deleted. The next pass
  then destroyed it. This is what made the two halves agree.

  - `IterationCheckpoint.workingState` — optional, so checkpoints written
    before this field exists restore exactly as they do today.
  - `snapshotWorkingState` / `restoreWorkingState` handle the wire shape.
    `WorkingState.files` is a `Map`, which JSON renders as `{}`, so a naive
    snapshot would have silently lost every tracked file. Eviction counters
    round-trip too: a resumed summary that forgot what it had already dropped
    would claim a completeness it does not have.
  - State is restored directly rather than by replaying extractors over the
    restored messages — the messages the first pass compacted away are gone,
    so re-extraction is both lossy and non-idempotent.

- 935b8f3: Harden the MCP boundary: the host decides what enters the tool registry,
  and a server that changes its mind is noticed.

  - `MCPToolDiscovery` takes per-server `allow`/`deny` policies (`'*'` for
    servers without an entry). Discovery previously admitted whatever the
    server offered, which put the REMOTE side in charge of what the agent
    can call — the exact inversion of least privilege. Deny beats allow, so
    a self-contradicting config resolves restrictively.
  - Drift detection: the admitted tool set is fingerprinted (name +
    description + input schema) and compared on each discovery, with an
    `onDrift` callback reporting `added` / `removed` / `changed`. The
    fingerprint covers descriptions and schemas, not just names, because the
    attack shape is advertising something benign at approval time and
    swapping its meaning afterwards — the name never moves. Reported rather
    than blocked: a dev server legitimately changes between runs, and only
    the host knows which kind it is looking at.
  - Protocol negotiation is checked. A server answers `initialize` with the
    version IT will speak; the client ignored that answer entirely, so a
    version it could not speak looked like a healthy connection until
    something downstream broke oddly. It now refuses a version outside
    `MCP_SUPPORTED_PROTOCOL_VERSIONS` and names what it can speak. An
    ABSENT version is still tolerated — a missing field is a sloppy server,
    an unsupported version is a real incompatibility.

  `MCP_PROTOCOL_VERSION` deliberately stays at the version namzu actually
  implements. Advertising a newer one whose requirements are unimplemented is
  worse than advertising an older one honestly, because the server tailors
  its behavior to the claim. Raising it is a conformance task.

  Hosts that configure no policy see no behavior change.

- 935b8f3: Recover from a bad tool call without spending a model round trip on it.

  - `QueryParams.repairToolCall` — a last chance to fix a call the model got
    wrong, before the error reaches it. A malformed call otherwise costs a
    full round trip: the error goes back as a `tool_result`, the model
    re-reads the whole context, and issues a second inference to add a
    missing brace. The hook sees the reason (`invalid_json`,
    `schema_validation`, `unknown_tool`), the tool's JSON Schema and every
    registered tool name, and may rewrite the arguments and the tool name —
    nothing else. It is tried exactly once, a throw is caught, and declining
    is normal: the original error simply proceeds as before.
  - `ToolDefinition.maxRetries` (default `0`) + `ToolResult.retryable` — a
    transient tool failure can now be retried in-loop instead of going back
    to the model to be re-decided. Strictly opt-in per tool, because the SDK
    cannot know a tool is idempotent, and only for failures the tool marked
    retryable.
  - `PluginHookResult` `{action:'retry'}` finally does something. It was a
    declared variant that threw at every site that consumed it; in
    `post_tool_use` it now re-runs the tool, bounded by the same per-tool
    budget so a plugin cannot spin the executor. It remains an error in
    `pre_tool_use`, where nothing has run yet for it to mean anything.

  With no repairer configured and no tool opting into retries, behavior is
  unchanged.

- 935b8f3: Bound tool execution: per-tool deadlines, real cancellation, and a fan-out cap.

  `ToolContext.abortSignal` was produced by the executor and consumed by nothing —
  a repo-wide grep found only the two producer sites. A Stop tore down the model
  stream and then parked inside `Promise.all` waiting for a tool that had no idea
  it should quit, and there was no framework-level deadline at all: `bash`
  defaulted to **one hour**, and the MCP stdio transport to forever.

  - `ToolDefinition.timeoutMs` and `ToolExecutorConfig.toolTimeoutMs` (default
    120s). On expiry the executor stops waiting and returns a model-visible
    error result, so a slow dependency becomes something the agent can route
    around rather than a turn that never comes back.
  - The tool's `context.abortSignal` now really fires — on the deadline and on a
    run abort — so cooperative tools stop working instead of merely being
    detached. `bash` passes it to the child process.
  - `bash`'s default timeout drops from 1 hour to 2 minutes. The model can still
    request longer through the tool's own `timeout` argument.
  - `ToolExecutorConfig.maxToolConcurrency` (default 8) bounds the parallel
    branch of `executeBatch`, which previously fanned out without limit.
  - MCP: `MCPClientConfig.requestTimeoutMs` (default 30s) bounds every JSON-RPC
    round trip; in-flight requests are now rejected when the transport closes or
    errors, not only on an explicit `disconnect()`; and a server-initiated
    request (`sampling/createMessage`, `elicitation/create`, `roots/list`,
    `ping`) gets a `-32601` reply instead of being silently discarded, which
    used to leave the server waiting forever.

- 935b8f3: A tool can declare that its output IS the answer

  Every delegation path is blocking: the worker's final text comes back as the dispatching call's result. The loop then went round once more purely to restate what the worker had already said — a full model call at the parent's context size, the most expensive call in the run. It is also lossy, because the parent paraphrases the worker's answer through its own compacted view, so the caller receives the summary rather than the answer. For a router agent, whose entire job is to pick a specialist, that doubled the cost of every request.

  `terminal: true` on a tool settles the run with that tool's output — the rule `structured_output` has always had, now available to any tool. `buildAgentTool({ terminal: true })` sets it on the built-in delegation tool.

  It is honoured only when the terminal call is the only call in the turn and it did not fail. A model that asked for other work in the same turn meant to see those results, and settling would discard answers it requested; an error is not an answer either, and the model is the one that should read it. Both cases take the ordinary path and log the reason rather than quietly costing the relay the flag was set to avoid.

  `defineTool` also gained `maxRetries` and `outputSchema` passthrough. Both fields were already read by the runtime, and the sanctioned way to author a tool had no way to set either — the documented "the tool author opts in, per tool" was reachable only by hand-writing the interface.

- 935b8f3: A long-running tool can report progress.

  Tools get a deadline of up to two minutes by default, and before this they
  were silent for all of it: a host could show that a build, a test run or a
  long fetch had started, and then nothing at all until it finished or timed
  out.

  - `ToolContext.report(message, fraction?)` — fire-and-forget, returns void,
    never throws back into the tool, so it can be called without wrapping.
  - `tool_progress` run event (wire: `tool.progress`), carrying the tool name
    and `toolUseId` so a host rendering a concurrent batch knows whose
    progress it is. A `fraction` outside [0,1] is clamped rather than passed
    on.
  - Ephemeral, like `text_delta` — excluded from `transcript.jsonl`, so a
    tool reporting every file it compiles cannot bloat the durable record.

  The model never sees these. Progress answers "is it still working?", which
  is a question only a human asks, and putting it in the conversation would
  spend tokens telling the model something it cannot act on.

- 935b8f3: Add an evaluation harness with trajectory scoring.

  There was no evaluation harness of any kind — no dataset, no scorer, no judge,
  no trajectory assertion. So namzu's most load-bearing behavior was tuned by
  constants nobody could measure: `search_tools` activates the top 5 deferred
  tools, compaction fires at 0.7 of the window, six state lists cap at 25. Change
  any of them, or a builtin tool description, or the deferred-tools prompt block,
  and there was no way to learn the agent now takes four tool calls where it took
  one — short of a user hitting it.

  ```ts
  import {
    runExperiment,
    trajectoryScorer,
    completionScorer,
    evalRunFromQuery,
  } from "@namzu/sdk";

  const report = await runExperiment({
    name: "file-editing",
    cases: [
      {
        name: "edits after reading",
        input: msgs,
        expectedTools: ["read", "edit"],
      },
    ],
    scorers: [trajectoryScorer(), completionScorer()],
    run: (input) =>
      evalRunFromQuery(query({ provider, tools, messages: input /* … */ })),
  });
  ```

  - **`trajectoryScorer`** scores the tool sequence as F1 over the longest common
    _subsequence_. Subsequence, not set intersection: reading a file before
    editing it is not the same run as editing then reading. Extra calls cut
    precision, missing calls cut recall — so "did the right thing wastefully" and
    "skipped a step" get different scores, which a final-answer assertion
    collapses into one.
  - `completionScorer`, `stepBudgetScorer`, `containsScorer`, and `customScorer`
    for anything else — including a model-graded judge, which is just an async
    predicate that calls a provider.
  - **Every `Score` carries a required `reason`.** A bare number tells you a run
    got worse without telling you how, which is exactly when you need to know;
    `formatReport` prints those reasons for failures rather than a bare mean.
  - A case that throws is a _result_, not a crash: a suite whose first broken
    case aborts tells you nothing about the other forty. Same for a scorer that
    throws.
  - `evalRunFromRun` / `evalRunFromQuery` bridge a finished `Run` into the shape
    scorers consume. That bridge is three lines of mapping only because
    `Run.steps` exists — otherwise a trajectory scorer would have to correlate
    raw `RunEvent`s by iteration number and diff cumulative counters.

- 935b8f3: A user message can carry a document

  Documents existed in the type system only in the tool-result direction, and both first-party drivers mapped images only on the input side. So "here is the contract, answer questions about it" — a mainstream workload — was reachable only by having a tool read the file and stringify it. That loses the provider's native document handling (page structure, built-in OCR, citations) and pays the text cost instead.

  `UserMessage.attachments` is now `MessageAttachment[]`: an image or a document. The discriminant is optional and stays optional — an attachment without one is an image, which is what every attachment was before, so no existing caller changes.

  `supportsDocuments` sits beside `supportsVision` in the driver capability declaration, and the runtime checks it the same way: a document sent to a driver that declares `false` warns before the request, or throws under `strictCapabilities`, instead of letting the model answer about a file it never saw. The two are counted separately because they are separate wire shapes and a driver can map one without the other.

  The two first-party drivers map documents natively. The remaining five map images only and now say so; a document reaching them degrades to a named placeholder that says which kind was dropped, rather than one that calls a document an image.

- 935b8f3: Stop compaction from quietly degrading the state it produces, and implement
  `resetThreshold`.

  What survives compaction is the only record of the history it replaced, so
  silently shrinking it is the one thing that structure must not do. Three fixes:

  **Capped lists keep their head.** Eviction used `shift()` — oldest-first — so
  on a long run the 26th assistant note deleted the 1st, and "the structured
  state that survives compaction" degraded into a rolling window over recent
  activity. The early entries are the load-bearing ones (the original
  requirement, the decision that set the approach); the recent ones are still in
  the un-compacted tail of the conversation. The first `keepFirstEntries`
  (default 3) are now pinned and eviction takes from the middle. Tool results
  keep oldest-first eviction, because there recency genuinely wins: an old `read`
  of a since-edited file is worse than useless.

  **The summary admits what it lost.** Evictions are counted per slot and
  rendered as `_(N entries dropped to stay within the state budget)_`. A summary
  that presents a gap as complete is worse than one that admits the gap — the
  model reasons about a fragment as if it were the whole record.

  **Unrecognised tools get a useful summary.** Every MCP tool, custom tool and
  connector-bridged tool fell into a flat 120-character head slice, which on JSON
  spends the entire budget on syntax: `Ran: {"results":[{"id":"a1b2` and nothing
  else. Unknown tools are the ones a summary can say least about from the name,
  so they now get 400 characters and a structure-aware slice — array length and
  element shape, or object keys — falling back to head-and-tail for plain text.

  **`resetThreshold` is implemented rather than deleted.** It was declared, set
  by the shipped CLI, and read by nothing. It is hysteresis: a pass that only
  moves the context from 0.72 to 0.71 of the window leaves the trigger armed, so
  the next iteration compacts again, paying a summarization call and busting the
  prompt-cache prefix each time for nothing. A pass that cannot reach the reset
  level now logs the shortfall, and `compaction_completed` carries
  `reachedResetThreshold`.

### Patch Changes

- 935b8f3: Atomic writes stop sharing one scratch file.

  The rename is what makes a write atomic — a reader sees the old file or the
  new one, never a half-written one. The sidecar it renames _from_ has to be
  private to that write, and in seven places it was a fixed `${path}.tmp`.

  Two writers of the same record then shared one scratch file: both opened it,
  both wrote into it, and the first rename published whatever mixture had
  landed while the second renamed a file that was no longer there. That is the
  exact failure atomic writes exist to prevent, reached through the mechanism
  meant to prevent it.

  Not hypothetical for this SDK: the cross-process park and unpark handoff —
  one process suspending a run, another resuming it — is a design where two
  processes legitimately touch the same records, and it is the feature these
  stores exist to serve. One store already picked a private name; the other
  seven inherited the fixed one.

  - One `atomicWriteFile` in `utils/`, used by the session, thread, run, task
    and memory stores, the retention backend and both migration writers. The
    sidecar carries the process id, a per-process counter and random bytes —
    distinct within a millisecond, within a process, and across hosts sharing
    a network mount.
  - It lives in `utils/` rather than `store/` because one of those writers was
    _deliberately_ duplicated to avoid an inbound dependency on the store
    layer. That instinct was right, and it is also why that copy kept the
    fixed name after the others were fixed; somewhere everything may depend on
    leaves nothing to duplicate.
  - A rename contended by a concurrent writer is retried briefly. Replacing an
    existing file by rename is unconditional on POSIX and not on Windows,
    where a concurrent writer holding the target fails the call for as long as
    the other rename takes — and two processes writing one record is precisely
    what this helper is for. Bounded to five attempts, so a genuine permission
    error still fails immediately instead of hanging.

- 935b8f3: The third-party-name audit now covers prose, not just source

  The rule namzu holds is that nothing here takes its naming from another system and no brand appears in prose. The guard that enforces it scanned `.ts` only — so the largest prose surface in the repository, every README and published page, was never checked, and it had accumulated exactly what the rule refuses: a competitor feature grid, a scoring table, "in the spirit of X", "our tool names mirror Y's table verbatim", and a sandbox tier matrix written as market positioning.

  Markdown is scanned now, with the same distinction the source side already draws. An inline code span, a fenced block, a link target and YAML frontmatter are values a reader types verbatim — a package path, a model id, a keychain item — and they are exempt. A published page may also name a service namzu ships a driver for, because telling an operator what it connects to is the page's job; source comments get no such licence, since a vendor is never the reason namzu's own code has its shape.

- 935b8f3: Four defects an adversarial audit confirmed

  **A task could be created and then never found again.** `DiskTaskStore` writes under the run that created it and read only under the store's default run, so every lookup missed as soon as the two differed — the normal case, since the task tools are built with the live run id while a long-lived host constructs the store once with a fixed default. `create` succeeded, `list` succeeded, and `update`, `delete`, `claim` and every dependency link answered "not found" for a task the caller could see. The in-memory store keys by task id alone, which is why nothing caught it.

  **A sub-agent's token reservation was never returned.** The debit at spawn reserves headroom so siblings cannot each be promised the same tokens, and nothing credited back the unused part — so a pool shrank by the full allocation on every spawn no matter what the child used. At a half-pool fraction, ten delegations left a parent with a thousandth of its budget and the next spawn was refused for a budget that had barely been spent. The debit also ran before provisioning, so a spawn rejected for capacity still burned its allocation — the one state change the comment there promised would not happen.

  **A failed sandbox create leaked a proxy holding real credentials.** The egress proxy starts before the container and its only close was in `destroy()`, which a create that never returned can never reach. Every failure in between left a listening server on loopback stamping credential headers, plus a retained event-loop handle, one per retry.

  **A remembered approval could overrule the operator.** The grant check ran before the verification gate and returned, so a remembered approval skipped the gate entirely — and because a tool-scoped grant matches any arguments, approving one harmless invocation authorised every other one, past a rule written to stop exactly that. The gate now runs first, and a grant can satisfy a review but never a denial.

- 935b8f3: Retry now works on the bedrock driver, and the shared classifier reads a
  status wherever a vendor hides it.

  An unclassified error is treated as non-retryable, which is the right
  default — but it meant the retry policy was effectively dead on this
  driver, and the one failure most worth backing off from was the one that
  killed the run. The service reports failures as named exception classes,
  and the classifier looked at neither the name nor the status, because the
  status lives in a metadata bag rather than on the error.

  - `classifyProviderError` now also reads `$metadata.httpStatusCode`. A
    status is a status wherever it hides, and this helps any driver — first
    or third party — whose SDK reports it that way.
  - The bedrock driver maps its own exception vocabulary to provider error
    codes: throttling and quota to `rate_limit`, unavailable and not-ready to
    `overloaded`, internal and stream faults to `server_error`, and the
    non-retryable ones (`ValidationException`, `AccessDeniedException`,
    `ResourceNotFoundException`) to their exact codes so they fail fast
    instead of burning the retry budget.

  The vocabulary lives in the driver rather than the shared classifier: a
  driver knows its own vendor's error names, and the classifier should stay
  generic. An unrecognised exception passes through untouched — an honest
  unknown beats a confident wrong classification.

- 935b8f3: A cancelled turn records what it spent before it stopped.

  Cancel re-threw from inside the chunk loop, so everything past that point
  was unreachable — and everything past that point is the turn's bookkeeping.

  - **Silent cost under-reporting**, the load-bearing one: the usage the
    stream had already merged was discarded wholesale, so `Run.tokenUsage`
    and `costInfo` under-reported every cancelled turn. A cancelled turn is
    not a free turn; the tokens were spent.
  - The `chat {model}` span opened for the call was started and never ended,
    so it never exported at all.
  - The message the turn announced never got a terminator, so a host
    consuming the message lifecycle saw a message begin and never end.
  - The streamed text was absent from the run's messages and steps.

  The stream-**error** path a few lines away already settled all of this.
  Cancel was the one exit that skipped it, which is the opposite of what its
  frequency deserves.

  `MessageStopReason` gains `'cancelled'` so the terminator can be
  well-formed. Settling is best-effort and never replaces the reason the turn
  ended: the cancellation still propagates, so the run loop still settles as
  cancelled.

- 935b8f3: A damaged checkpoint is refused instead of skipped.

  A checkpoint file is the **only** durable record of a park — there is no
  separate approval store. So an unreadable one that gets logged and skipped
  does not merely lose a resume point: `findPendingCheckpoint` reports "not
  parked" and drops an approval a human already granted.

  `listCheckpoints` wrapped every per-file read in a `catch` that warned and
  continued, returning a silently short list that four callers treat as
  complete:

  - `'latest'` resolution and `newest()` quietly resume from an **older**
    checkpoint, so the run re-executes a full iteration of tool calls;
  - `findPendingCheckpoint` loses the park, as above;
  - `prune` under-deletes, because a file the keep-count cannot see is
    immortal.

  The only signal was a `log.warn` on a line nobody watches — and the by-id
  read next door was already strict. Two read paths disagreeing about whether
  damage matters is how the lenient one gets trusted.

  Both paths now refuse. Both also **check** the parsed shape rather than
  casting it: `JSON.parse(content) as IterationCheckpoint` let `{}` through
  and failed much later at the point of use, where the message names a
  missing property rather than a damaged file.

  Absent stays distinguishable from damaged: no checkpoints still returns an
  empty list, and an unknown id still returns `null`.

- 935b8f3: Compaction no longer leaves the conversation opening on an assistant turn.

  After compaction the kept tail **is** the conversation: the summary is
  written as a system message and every driver hoists system messages into
  their own request parameter, so the first kept message becomes the first
  message on the wire. A conversation that opens on an assistant turn is
  rejected.

  `findSafeTrimIndex` advanced past an orphaned `tool` message and never past
  an `assistant` one. How often that bit depends on the shape of the history,
  and the shape that matters most is the worst: in a **multi-step turn** — the
  agent working through several tool calls without the user speaking in
  between — the tail alternates assistant and tool with no user message in it
  at all, so essentially every boundary landed wrong.

  The failure was unrecoverable. The resulting rejection is not classified as
  an overflow, so relief never fires and the run dies — compaction, whose
  entire job is keeping a long run alive, becoming the thing that ends it.

  The boundary now advances to a `user` turn. Where none lies ahead it falls
  back to the nearest one behind **whose own tail is free of dangling tool
  pairs**: two wire invariants are in play, and satisfying one by breaking the
  other is not a fix. Where no boundary satisfies both, the input was already
  unsendable and no cut makes it otherwise, so the prior behaviour stands
  rather than a different invalid conversation being invented to replace it.

  Also fixed alongside: the structured manager took
  `Math.min(safeTrimIndex, desiredTrimPoint)`, and since the safe index only
  ever moves forward of the desired one, that minimum resolved back to the
  desired point every time — discarding the entire safety search. Whatever the
  guard was reaching for, what it did was undo the line above it.

- 935b8f3: Four arithmetic defects, each pinned by a computed counterexample.

  - **`mergeTokenUsage` maxed `totalTokens` as an independent field.** It is
    derived (`input + output`), and Anthropic reports the input on
    `message_start` and the output on `message_delta` — so the two frames
    carry totals of 1200 and 350, and the max returns the larger _component_
    rather than the sum. Merged: 1200. Correct: 1550. Every completion token
    was invisible to the token-budget hard stop, which reads only
    `totalTokens`. The merge now also takes `prompt + completion`, so it is
    monotone and can never under-report.

  - **The compaction estimator counted array-shaped tool results by block
    count.** `msg.content.length` on `ToolResultBlock[]` is the number of
    blocks, so a tool result carrying a 400 KB screenshot contributed **1**
    character — and the estimate that decides when to compact read near zero
    for exactly the runs that need compacting most.

  - **`toolsHash` omitted `annotations`.** Those carry `readOnlyHint` and
    `destructiveHint`, which become `isReadOnly` / `isDestructive` and drive
    whether a human reviews the call. A server could flip a tool from
    destructive to read-only — same name, same schema, silently removed from
    review — and the fingerprint built to catch that rug-pull produced an
    identical hash.

  - **Sub-agent budget exhaustion inverted into no budget.**
    `floor(remaining * maxBudgetFraction)` reaches 0 once the parent drops
    below `1 / maxBudgetFraction`, and `tokenBudget: 0` means _uncapped_
    downstream (`LimitChecker`: `tokenBudget > 0 && …`). So the most depleted
    parent in the tree was the one that spawned an unlimited child. Spawning
    now refuses with a clear error; a caller who wants an uncapped child says
    so explicitly.

- 935b8f3: Parent the OpenTelemetry spans, and emit the missing `chat` span.

  Every span was a root. A repo-wide grep for `context.with` / `trace.setSpan`
  returned zero hits, so a single 20-iteration run landed in Honeycomb as 21
  disconnected root spans plus N orphan tool spans — no waterfall, no way to see
  which iteration a slow tool belonged to. There was no span around the model
  call at all: `chatSpanName` existed with zero call sites, so traces carried no
  LLM latency, and the token counts were stamped on the iteration span instead of
  the operation that produced them.

  The fix is explicit parent contexts rather than `startActiveSpan`. Every
  span-owning body in the run loop is an async **generator**, and a generator
  resumes on its consumer's async context — so the ambient parent is already gone
  by the time a child span is created, and the naive conversion silently parents
  nothing. `parentContext(span)` threads it as a value instead.

  - Iteration spans parent to the run span; tool spans parent to the iteration
    that requested them, via a new optional `ToolContext.parentSpan` (already
    threaded to exactly the right place).
  - A `chat {model}` span carries `gen_ai.operation.name`, request model,
    temperature and max tokens, and on completion the response model, id,
    finish reasons, token usage and the cache-read/write counts.
  - `@namzu/telemetry` switches from `SimpleSpanProcessor` to
    `BatchSpanProcessor`, so exporting a span no longer puts network latency
    inline on the agent loop.

  Adds the first telemetry tests in the repo.

- 935b8f3: Carry budgets across a checkpoint resume, and count the side-channel model calls.

  Budget enforcement was neither durable nor total.

  **Durable.** `IterationCheckpoint` faithfully persisted `tokenUsage`, `costInfo`
  and `guardState`, and the resume path replayed messages only — the numbers were
  written and then discarded on the way back in. A run checkpointed at $4.80 of a
  $5 cap came back with a brand-new $5 and a brand-new timeout clock, so a task
  that parked five times spent 5x its cap while every invocation truthfully
  reported itself in budget. `RunPersistence.restoreUsage()` and
  `GuardCoordinator.restoreElapsed()` (also available as `elapsedMsOffset` at
  construction) seed both from the checkpoint before the first iteration, so a
  resumed run that is already over budget stops immediately.

  **Total.** Three `chatStream` call sites bypassed `accumulateUsage` entirely, so
  a run with `tokenBudget: 200_000` could send well past 200k and never trip
  `token_budget`:

  - the advisory phase — its usage was already captured for reporting and simply
    never reached the accountant;
  - the compaction verifier — the worst offender, since it fires exactly when the
    context is largest. It now takes an optional `UsageSink`;
  - `RouterAgent` — routing runs before any `RunPersistence` exists, so
    `RoutingDecision` now carries the routing call's `usage` (summed across
    retries) and the router folds it into the result instead of reporting the
    delegate's usage alone.

- 935b8f3: namzu takes its naming from nobody, and now there is a gate that proves it.

  `scripts/audit-external-names.mjs` refuses a third-party product name in a
  comment or an identifier, and runs in CI. It found 31 real ones — most of
  them in the TUI, where the design was being explained as "modelled on how X
  presents text", "X-style grouping", "like X / Y".

  That is the failure the rule exists for. A design explained by reference to
  somebody else's product has handed over its rationale: the next reader
  reaches for that product's model instead of asking what namzu is trying to
  achieve, and when the reference changes the comment becomes a claim nobody
  can check. Each one now states the same decision on its own terms — what it
  accomplishes, and what breaks without it.

  The kernel had eleven, all in prose explaining a wire behaviour by naming
  the vendor whose endpoint exhibits it. A 400 for an unanswered `tool_use`
  is a property of the protocol, not of a company; several function-calling
  endpoints report `stop` alongside populated tool calls, and which ones is
  not the point.

  The identity prompt named the products it told the model not to be. It now
  says the stronger thing without them: the underlying model is an
  implementation detail of how namzu runs, not who it is.

  What the audit deliberately does NOT flag, because a rule that cries wolf
  gets switched off: wire values and the files that carry them. A
  context-window table keyed by model id must contain real model ids or it
  resolves nothing; a driver package is named after the service it drives.
  The exemption is per path and narrow, and the script says where the line
  falls. Scanning string literals was tried and rejected in the same spirit —
  it flagged driver ids in switch statements and model ids in test fixtures
  everywhere, which would have meant exempting half the tree.

  Two matcher details worth keeping: the camelCase check is case-SENSITIVE,
  because an `i` flag turns `[A-Z]` into `[A-Za-z]` and the rule starts
  rejecting `coherent` for `cohere` and `strands` for the English verb. And
  `cursor` is absent from the list entirely — it collides with the pagination
  cursor this codebase threads through every list call.

- 935b8f3: `glob`, `grep` and `ls` stay inside the working directory, and inside the
  sandbox when there is one.

  Two independent failures, both in tools that are in the default set.

  **The path escape needed no sandbox at all.** All three resolved a
  caller-supplied `path` against the working directory bare, so
  `path: "../../.."` landed wherever that pointed and the tool read it
  happily. The containment rule already existed — in one private function
  inside the local sandbox provider — and these never reached it. `grep`
  returns file **content**, so what escaped was not a listing. For `glob` the
  same escape also rides in on the _pattern_, since the base directory lifted
  out of `"../../**/*.pem"` is caller-supplied too.

  A refusal now reaches the model as a failed tool result carrying the reason,
  rather than a throw, so it can correct itself.

  **The sandbox was not a read boundary.** `glob` and `grep` called
  `node:fs/promises` against the host working directory and referenced
  `context.sandbox` nowhere, while every sibling builtin already remembered
  the branch. With a container backend wired in they read the SDK process's
  own filesystem. The paths they returned were host-relative too, while
  `read` resolves what it is handed _inside_ the sandbox — so every
  search-to-read handoff either failed or opened a different file. The two
  roots genuinely diverge: the executor passes `workingDirectory` through
  unchanged alongside the sandbox.

  Both now route through `context.sandbox` when present. `grep` abstracts only
  the file _source_ — enumerate and read — so matching, context lines and the
  caps stay one implementation; duplicating the substantive half is how the
  two paths would drift, and the sandboxed one is the one nobody runs by
  accident.

  **Sandbox paths are no longer run through the host's path module.** A
  sandbox is a POSIX filesystem whatever the host runs, so resolving its paths
  host-side rewrites them whenever the two disagree — on a Windows host
  `resolve('/workspace')` becomes `C:\workspace`, and a container path stops
  being a container path. This was found by the new tests, which returned no
  results at all until it was fixed.

- 935b8f3: Fix five wiring defects found by auditing the previous wave rather than
  trusting it. All five had passing unit tests, because those tests
  constructed the internal class directly and so proved the helper worked
  while proving nothing about whether `query()` ever reached it.

  - **`query({ repairToolCall })` was a no-op.** The field was spread into
    `ToolingBootstrap.init`, whose config type has no such field and whose
    `init` enumerates what it forwards. Object spread bypasses excess-property
    checking, so it type-checked and did nothing.
  - **A truncated tool-input stream never reached the repairer** — the case
    the hook exists for. `executeSingle` answered `inputTruncated` with a
    generic hint and returned before repair ran. The partial buffer is now
    preserved (`ToolCall.metadata.partialArguments`) and offered to the
    repairer, because one handed an empty object has nothing to work from.
  - **`{action:'retry'}` from `post_tool_use` was silently discarded.** It was
    read inside a loop bounded by the tool's `maxRetries`, which defaults to
    0, so the loop body never ran. Hook-requested retries now get their own
    bounded budget (`HOOK_RETRY_BUDGET`): the hook is host code reacting to
    one specific result, a more specific signal than the tool's blanket
    idempotency declaration.
  - **A cross-process HITL resume never cleared the park.** The approved batch
    executed and the checkpoint kept `pending` with no `resolvedAt`, so an
    approval queue re-served a destructive call that had already run — the
    exact failure recording the park exists to prevent.
  - **Configuring an output guardrail rewrote the run's outcome.** The branch
    called `markCompleted()` purely to materialize the produced text, so a
    cancelled run reported `completed` merely because a safety check was
    present. Reading and settling are now separate (`materializeResult`), and
    `setResult` is sticky so the later `resolveResult` cannot re-expand a
    redaction back to the raw model output.

- 935b8f3: Fix five defects in the eval harness and RAG retrieval — all plain bugs
  with correct answers, not design trade-offs.

  **Eval harness — it could report green on a broken suite.**

  - A case whose run THREW scored 1.0. `executeCase` catches the failure and
    returns an empty run, and an empty run walks into every scorer's happy
    path: `stepBudgetScorer` sees 0 steps against its allowance and returns
    1, `trajectoryScorer` sees "no tools expected, none called" and returns
    1. The failure was recorded on `run.error` and nothing consulted it. Any
       run that failed now scores 0, with the error as the reason.
  - Two scorers sharing a name silently collapsed. Scores are keyed by name,
    so a second `containsScorer(...)` — also called `contains` — overwrote
    the first, and the case mean's denominator became the count of distinct
    NAMES rather than scorers run. With one scoring 0 and one scoring 1 the
    suite reported 1.0 where the honest answer is 0.5. Duplicate names now
    throw.

  **RAG retrieval.**

  - `bm25Score` implemented only the term-frequency saturation half and no
    IDF at all — the half that discriminates. Without it every matched term
    weighs the same, so a chunk matching three common words outranks the one
    chunk containing the rare term the query was about. It also normalized
    document length against a hardcoded `avgDl = 256` rather than the corpus
    in front of it. Both now computed from the candidate set.
  - `hybridSearch` blended bounded cosine with unbounded BM25 linearly, so
    `hybridAlpha` did not weight the two halves — whichever scale happened to
    be larger won. Each ranking is normalized to [0,1] first.
  - The recursive chunker used `text.split(sep)`, which DELETES the
    separator: splitting on `'. '` stripped every sentence terminator and
    `'\n\n'` stripped every paragraph break, so the chunk shown to the model
    was not what the document said.

- 935b8f3: A tool call a probe vetoed now says it failed.

  The probe-veto branch was the only result-producing branch in the executor
  that left `isError` off, and `isError` being optional meant the compiler
  could not catch it. Five lines above, the `tool_completed` event for the
  same veto carried `isError: true` — so a run's event stream and the result
  it returned disagreed about the same call, in the same function.

  Four things degraded off that one omission:

  - Two drivers emit their failure marker only when this is true, so the model
    read a **successful** result whose body begins `Error: Probe "x" vetoed…`
    and the failure-recovery path it was trained on never fired.
  - The persisted step recorded a literal `isError: false`, so the run record
    contradicted its own event stream.
  - Compaction guards error results from being cleared; a vetoed result was
    silently excluded from that protection.

- 935b8f3: A provider fault keeps the classification its driver produced

  The stream turn flattened a classified `ProviderError` to its message and threw a fresh error in its place, so `retryable`, `status` and `retryAfterMs` were all discarded — and `NamzuError`'s default for `provider_error` is not-retryable. A 429 or 529 that had exhausted its backoff therefore settled the run **failed**, where the documented behaviour is a **pause** with a checkpoint to resume from. `toPlatformError` already projects the right shape; it was simply never handed one.

  The asymmetry was visible in the codebase: the same fault raised inside the compaction verifier propagates untouched and does pause, so identical faults settled oppositely depending on whether compaction happened to run that iteration. A classified failure is now rethrown as itself, and an unclassified one keeps its cause.

- 935b8f3: Four places where the runtime lost information it was holding, or admitted a limit it had already exceeded.

  - **A clipped sandbox stream said nothing.** `SandboxExecResult` carries `stdoutTruncated` / `stderrTruncated`, added when the other backend needed to report a clipped stream. The local backend clipped at the same cap and never set them, so the model read a complete-looking result whose tail was gone — against the contract's own note that the kernel does not truncate silently. The tool layer already renders the flag; nothing raised it. The accumulator is now a small `CappedStream` that reports hitting its cap, and reports it at the first byte past it rather than at exactly the cap.

  - **Two concurrent spawns could both take the last delegation slot.** The width cap counted a parent's children and then created one, with every other provisioning step in between. Two spawns under the same parent both read the same count, both saw room, and both created, so a cap of N admitted N+1. Provisioning is now serialized per parent session — the narrowest key that makes the check and the write one critical section; spawns under different parents never contend. In-process only, which is the honest scope: cross-process capacity belongs to the store.

  - **`agent_task_list` forgot finished workers.** Terminal tasks leave the manager 30 seconds after they settle, and the gateway's list was rebuilt by looking each tracked id back up — so a task that finished a minute ago vanished from the exact tool whose description says to call it before declaring multi-worker work done. A supervisor could not tell an evicted task from one that never launched; both read as absence. The gateway now snapshots each task's settled summary while the manager still holds it, and prefers the live record whenever there is one.

  - **The compaction summary hid its dropped tool results.** Every capped section in the working-state summary appends a line naming what it evicted — except tool results, which counted their evictions and rendered without them. The section carrying the most volume was the only one presenting a fragment as the whole record.

- 935b8f3: Clearing a tool result no longer destroys the way back to it, and skill
  frontmatter fails loudly instead of quietly.

  **A cleared tool result kept its recovery pointer.** When a result exceeds
  the output budget its full text is written to disk and a line pointing at
  the file is embedded _in_ the result. Compaction then replaced the whole
  content with a placeholder — deleting that line for exactly the largest
  outputs, and advising the model to "call the tool again", which is advice to
  re-run something that returned megabytes. The spill line now survives, along
  with the `read`/`grep` instruction that goes with it.

  A head and tail survive too. Clearing was total, so a result just over the
  1,000-character minimum lost 100% of itself — including the few lines the
  agent was actively reasoning from — to reclaim a few hundred characters. A
  result shorter than the head and tail together is kept whole, since eliding
  it would drop content while saving nothing.

  **The skill frontmatter fence is anchored to a line.** An unanchored search
  for `---` cut the frontmatter at the first occurrence anywhere — inside a
  quoted value, inside a URL — which both truncated the metadata and spilled
  the remainder into the body, where it reaches the system prompt verbatim.

  **YAML this reader does not implement is refused rather than mangled.** The
  reader is a flat key/value splitter and the documented contract says "YAML
  frontmatter" with no restriction, so an author has every reason to write a
  block scalar or a flow sequence. `description: >-` produced the literal
  string `">-"`, which passed validation and registered with no warning — the
  skill existed and was never selected, because its description said nothing.
  `[Read, Grep]` became that literal text and was interpolated into the
  prompt. Both now name the file and the field.

  That is worse for exactly one skill — the one already silently broken — and
  better for everyone looking for it.

- 935b8f3: **Breaking:** `@namzu/sandbox` declares only the backends it has.

  Four of the shapes this package offered could type-check and then throw: a `process` tier, a `passthrough` tier, and two adapters to third-party managed schedulers, none of which was ever written. Each demanded required configuration for a call that was never made — the `self-hosted` microvm arm went further and required three fields belonging to a local-daemon path that does not exist, while the two fields the working path needs were optional. So the only configuration that ran had to supply three values nothing reads, and omitting the two that matter compiled its way to a runtime throw.

  `SandboxTier` is now `container | microvm`. `MicroVMBackendConfig` is one shape whose `orchestratorEndpoint` and `getToken` are required. `SandboxBackendNotImplementedError` stays exported and thrown: a JS host that invents a tier gets a named refusal rather than a provider that confines nothing.

  The `sandbox.platform` health check now asks the provider what this host enforces instead of answering from a table keyed on the OS name. That table had drifted both ways — it called the Linux probe unimplemented long after the provider began probing real flags, and it told a Windows operator that sandboxing is "not supported", which is true of the in-process tier and silent about the container tier that runs there. Every non-passing result now names the missing controls and what to do about them.

  `SANDBOX_ISOLATION_CONTROLS` is exported as a value from `@namzu/sdk`. It was reachable only through `export type *`, so importing it type-checked and then failed on the first line of a built binary.

- 29f35c8: Constrain `ask_user_question` to its canonical JSON object-array input on
  supported providers and reject malformed compatibility shapes at runtime.
- 935b8f3: Overflow reaches the rescue that exists for it.

  Overflow is the one 4xx the runtime can act on: it sheds history and
  retries. Everything else in the 400 family is surfaced. So the rescue is
  gated on the code being **exactly** `context_length_exceeded`, and anything
  that misses that gate dies holding the remedy.

  Three things missed it. Measured before and after, five of six realistic
  overflow shapes never reached relief; now all six do.

  - **The structural code was extracted and then discarded.** The cause-chain
    walk returned the first `code` it found and fed it only to the two
    transport-errno sets, so a provider that said `context_length_exceeded` in
    the one field designed to say it was answered with a substring search that
    did not match. A structural code is now consulted **before** the status,
    because it is strictly more specific: a 400 is a category, the code is the
    diagnosis. The gateway `type` discriminator and a nested error envelope
    are read the same way.
  - **The phrase list missed the common wordings.** "too long for", "maximum
    length", "exceeds the maximum", "input is too large" all fell through to a
    plain non-retryable invalid request.
  - **The Converse driver pre-filed `ValidationException` as
    `invalid_request`.** That name covers both a malformed request and a
    prompt past the model's window, and only one of those is recoverable — so
    guessing from the name made the recoverable case unrecoverable by
    construction, because the shared classifier short-circuits on an error
    that already carries a code and never read the body. It now hands that one
    name to the classifier. The result is still a `ProviderError`, so the
    driver's contract is unchanged; it just stops answering a question it
    cannot answer from the name alone.

  The rate-limit half of the same class is fixed alongside: a provider that
  reports `rate_limit_exceeded` structurally under a 400 is now retryable
  instead of being filed as a bad request.

- 935b8f3: Answer every `tool_use` block, and stop a human approval from overriding a gate denial.

  Four tool-review paths — verification-gate all-deny, human `reject_tools`,
  `modify_tools` with everything denied, and `modify_tools` with a _partial_
  deny — returned without producing a `tool_result` for the calls they refused.
  The assistant turn stayed unanswered, so the next provider request was
  malformed (`400 … Did not find 1 tool_result block(s)`) and the run died.
  Any host wiring a rejection decision (including the `namzu` TUI's permission
  prompt) hit this on the first decline.

  `ToolExecutor.executeBatch` now takes an optional denial map and answers
  _every_ call in the batch: refused calls get a synthetic error `tool_result`
  carrying the reason instead of being executed. Because there is one place
  that turns tool calls into messages, the invariant now holds by construction.
  The refusal reason travels inside the `tool_result` rather than as a trailing
  `[SYSTEM]` user message, so a rejection steers the model instead of only
  stopping it.

  Alongside it, a policy-bypass fix: on the gate's _mixed_-decision path a human
  `approve_tools` replayed the full, unfiltered response and executed the calls
  the gate had denied. Gate denials are now threaded through every downstream
  execution, and a `modify_tools` rewrite can no longer resurrect a denied call.

  Checkpoint resume repairs unanswered tool calls (`removeDanglingMessages`)
  before replaying history, so a run parked at a tool-review checkpoint and
  resumed in a fresh process no longer fails on its first model call.

- 935b8f3: Fix three defects in delegation and compaction that unit tests could not
  see, because the numbers involved stay plausible-looking until you check
  their units and their object identity.

  - **A child agent's wall-clock deadline was a TOKEN count.** The fallback
    was `context.budgetTracker.remaining` read as `timeoutMs`. It hid because
    a six-figure token budget lands in a plausible range of milliseconds; it
    bit at the edges, where an unlimited budget (`0`) produced a child that
    was out of time on arrival. There is now an explicit
    `AgentManagerConfig.childTimeoutMs` (default 5 minutes).
  - **Sibling sub-agents each got a full share of the same pool.**
    `LocalTaskGateway` handed every spawn a _cloned_ budget tracker, so
    `AgentManager.spawn`'s `remaining -= allocatedTokens` debited a throwaway
    object. N children were each allocated `maxBudgetFraction` of the
    untouched parent total — N × 50% of a budget that only had 100% in it.
    The tracker is shared, as the debit always assumed.
  - **The compaction verifier sent `model: ''`.** Some drivers quietly
    substitute a default and others reject outright — on Bedrock the model id
    IS the endpoint. So compaction's LLM verifier failed exactly on the
    providers where a long run most needs it, and the failure surfaced as
    compaction killing the run it exists to save. It now receives the run's
    model.

  Each fix ships with a test that was confirmed to fail against the old code.

- 935b8f3: Normalize and memoize the tool schema that goes on the wire, and stop
  losing MCP schemas in translation.

  - `$schema` (`http://json-schema.org/draft-07/schema#`) was stamped on
    every tool's parameters and sent on every request. No provider reads it,
    and it rides in the tools block — position 0, inside the cached prefix.
    Stripped.
  - `toLLMTools` re-walked every registered tool's Zod tree once per
    iteration. Rendering is now memoized on the schema object and deeply
    frozen, so it is both free and byte-identical across iterations — the
    tools block heads the prompt-cache prefix, and a single reordered key
    invalidates the whole run's cache.
  - `mcpJsonSchemaToZod` collapsed `array` to `z.array(z.unknown())` and
    `object` to `z.record(z.unknown())`. Because a bridged tool's schema
    round-trips (server JSON Schema → Zod → JSON Schema on the wire), every
    MCP tool taking a structured argument was shown to the model as "an
    array of anything" or "an object with any keys" — nested properties,
    item types, enums and descriptions all gone. It is now recursive and
    faithful: nested objects, array items, enums, `const`, `anyOf`/`oneOf`,
    nullable (`type: ['string','null']`), descriptions and defaults survive.
  - MCP objects default to closed (`additionalProperties: false`) instead of
    `.passthrough()`, so the model is no longer told it may invent arguments
    the server never declared. A server that explicitly sets
    `additionalProperties: true` is still honored.

- 935b8f3: A turn that asked for tools no longer ends because the provider said it
  didn't.

  The iteration loop ended the turn on `finishReason === 'stop'` **before**
  looking at whether the model had asked for tools. Endpoints on the OpenAI
  wire shape — gateways and local servers especially — routinely report `stop`
  on the same response that carries a populated `tool_calls`, and three of
  this repo's drivers passed that value straight through.

  The damage was total and silent: every requested call skipped, an assistant
  turn left carrying `tool_use` blocks nothing ever answered, and the run
  settling as though it had finished the work it never started.

  - **The runtime now treats tool calls as the fact and the finish reason as
    the summary.** When they disagree, the calls win. This is the load-bearing
    fix: it protects every driver, including ones this repo does not ship.
  - **The three drivers that cast the reason raw now report it honestly** —
    a stream that produced a tool call reports `tool_calls`, whatever the
    endpoint called it. Defence in depth, and it makes the reported reason
    true for anyone else reading it.

  The existing suite could not catch this: the scripted mock reports
  `tool_calls` whenever it emits one, which is what an honest provider does
  and therefore never the case that breaks.

- 935b8f3: The question a run asked and the answer that resolved it match on the same key

  `user_question_asked` carried a `question_id` and `user_question_answered` did not, so a client that keyed on the question id — the natural key, since it is what routes an answer back on resume — could not match the two halves without also having stored the checkpoint id. The answered event now carries it whenever the resolution named one.

  Twelve event mappings across the SSE and agent-to-agent bridges shipped with no test: the nine event kinds added since those mappers were first written, plus the failure-classification and message-role paths. A wire transform with no test is a contract nobody checked — the field names are what a remote consumer parses, and the transforms return `Record<string, unknown>`, so renaming one is a break type-checking cannot see.

## 2.0.0

### Major Changes

- 6b0fbfd: Replace the built-in filesystem mutation contracts with one strict canonical
  shape per tool: `edit` accepts `path`, `old_string`, `new_string`, and optional
  `replace_all`; `write` accepts `path` and `content`. Remove line insertion and
  legacy aliases, serialize same-process mutations by resolved path, and document
  replay-safe marker advancement for bounded long-document writes. Local writes
  commit through same-directory temp files and atomic rename; sandbox
  implementations are required to provide the same atomic replacement contract.

### Minor Changes

- 11167dd: Separate runtime tool validation from canonical model-facing JSON Schema,
  propagate constrained-input hints through the agent loop, and map reviewed
  schemas to Anthropic strict tool use with capability-aware overrides. The
  built-in edit tool advertises only canonical arguments.

## 1.4.0

### Minor Changes

- 3fd2524: Normalize request-start and mid-stream failures across all seven provider
  drivers with the new public `ProviderRequestError` taxonomy. Errors expose
  `kind` (`throttle`, `network`, `auth`, `context_overflow`, `bad_request`, or
  `server`), `providerId`, and optional `status` / `retryAfterMs`, with
  `isProviderRequestError` available for structural narrowing across package
  copies.

  Provider error messages and metadata deliberately omit vendor response bodies,
  URLs, messages, and causes because upstream errors can echo credentials. HTTP
  dialect-mismatch diagnostics now keep only the endpoint origin and status.
  Caller-owned aborts remain unchanged instead of being reclassified.

  The runtime preserves the classified error through streaming and publishes its
  safe metadata as `Run.lastProviderError` and
  `run_failed.providerError`. Bedrock stream-exception events and provider
  iterator/SSE failures no longer appear as clean end-of-stream.

  `retryAfterMs` is metadata only; this change does not add retries or alter vendor
  SDK retry settings. Provider packages now require `@namzu/sdk >=1.3.0`, the
  first SDK release containing these runtime helpers and types.

  Ollama now maps `done_reason: "length"` truthfully so runtime continuation can
  run. LM Studio treats content-free `contextLengthReached` as context overflow,
  while preserving `"length"` after partial content, and creates its WebSocket
  client lazily on first use.

### Patch Changes

- c7cf4c7: Compaction can no longer delete the turn it is compacting.

  The recent-window boundary was snapped FORWARD to avoid splitting a tool pair,
  but that walk skips leading `tool` messages with no stop short of the end of the
  transcript. Whenever the whole suffix from the naive boundary is `tool` messages —
  one assistant turn fanning out at least `keepRecentMessages` parallel calls,
  measured at the start of the very next iteration, which is exactly where the
  compaction check runs — the boundary landed on `messages.length`, the recent
  window came back empty, and the rebuilt transcript held no non-system message at
  all. The model was then asked to answer a conversation whose last turn, including
  the user's own message, had been removed. The existing older-message floor guard
  cannot catch it: in that shape the older half is the whole transcript.

  The boundary is now the largest safe one AT OR BELOW naive, so a pass never
  removes more than the naive cut would and at least `keepRecentMessages` original
  messages always survive verbatim. When no safe boundary exists the pass is
  skipped and the transcript is left intact — one iteration of context headroom is
  cheaper than the live turn, and the condition clears itself as soon as the next
  assistant message moves the boundary past the tool block. The same change stops
  the leading system prompts being duplicated into the recent window when the naive
  boundary lands inside the system prefix. `findSafeTrimIndex` is unchanged and is
  reused as the safety predicate.

  Two smaller silent losses in the same area:

  An empty verification reply is now treated like `COMPLETE`. A truncated turn, a
  refusal, or an exhausted `llmVerificationMaxTokens` produced an empty string,
  which fell through to the append path and stamped a bare
  `## LLM Verification Additions` heading with nothing under it — an empty promise
  that then rode in every subsequent system prompt for the rest of the run.

  Every compaction count is `z.number().int().positive()` instead of
  `z.number().positive()`. Zod's base number check rejects only non-numbers and
  `NaN`, so `Infinity` and fractional values both parsed. `Infinity` was the
  dangerous one: it disarms the budget it guards rather than failing, so
  `convoTextBudget: Infinity` made `truncateMessages` a no-op and the entire older
  history was pasted into the verification prompt.

- f002c44: Add tool-specific validation recovery guidance and use it to show complete,
  safe `edit` call shapes when a model omits `path` or supplies an invalid
  `insertLine`.
- e9c974c: Remove the model-facing `cancel_task` coordinator tool from the default
  blocking worker protocol. A supervisor learns a `create_task` id only after
  that worker is terminal, and the old tool manufactured a successful
  "cancelled" result even when the gateway silently ignored a missing or
  terminal id. Host-owned run interruption remains available through the task
  gateway.

  Tighten the builtin `edit` contract so `insertLine` accepts only a
  non-negative JSON integer or the exact string `"end"`. Headings, anchors,
  numeric strings, `null`, and empty strings are rejected before execution;
  schema-bypassing callers receive the same refusal. This prevents `null` and
  empty values from being coerced to line `0` and silently inserting content at
  the beginning of a file.

## 1.3.0

### Minor Changes

- d7c683e: Add lazy provider registration: `ProviderRegistry.registerLazy(type, loader, options?)` plus async construction via `ProviderRegistry.createAsync()` / `createProviderAsync()`.

  Hosts that must not bundle every provider client into every entrypoint can now register a dynamic-import loader instead of an eagerly imported class — no more hand-rolled construction switches outside the registry. Registration never invokes the loader; the first `createAsync()` awaits it, validates the resolved `{ create }` module, and caches the factory. Concurrent first-creates share a single in-flight load, and only success is cached: a rejected load surfaces as the new `LazyProviderLoadError` (original failure on `cause`) and the next create retries.

  Capabilities integrate with capability negotiation: an optional `options.capabilities` hint lets `getCapabilities(type)` answer before the provider is loaded (no hint ⇒ permissive default), the loaded module's declared capabilities replace the hint, and the constructed instance's own `LLMProvider.capabilities` remain what the query runtime negotiates against.

  Lazy types are deliberately not constructible through the sync `create()` / `createProvider()` — those throw the new `LazyProviderSyncCreateError` deterministically so sync behavior never depends on load timing. Existing eager `register()` / `create()` behavior is unchanged.

## 1.2.0

### Minor Changes

- cc6b5f3: Pluggable checkpoint persistence with cadence and growth controls.

  Iteration checkpoints now flow through a new `CheckpointStore` interface
  (`types/run/checkpoint-store.ts`) keyed by the full run scope
  (`tenantId`/`projectId`/`sessionId`/`runId`) instead of a filesystem
  path, so hosts can persist mid-turn resume state in a shared backend
  (e.g. Postgres) that survives machine loss:

  - `QueryParams.checkpointStore?` injects a store per run (mirrors the
    existing `pathBuilder?` override); the disk layout under the run's
    output directory remains the default via the new exported
    `DiskCheckpointStore` conformance adapter over `RunDiskStore`.
  - `RunPersistenceConfig.checkpointStore?` +
    `RunPersistence.getCheckpointStore()`/`getRunScope()` expose the same
    seam to embedded callers.
  - The replay entry points (`listCheckpoints`, `prepareReplayState`)
    accept an optional `checkpointStore` + `scope` pair; their
    disk-addressed `baseDir` inputs are unchanged.
  - `CheckpointManager` now takes `(store: CheckpointStore, scope:
CheckpointRunScope)` — a breaking constructor change for direct
    constructions; the query pipeline threads it automatically.

  Growth control on the run config, byte-identical by default:

  - `AgentRunConfig.checkpointEvery?` (default 1 = every tool-call
    iteration, today's behavior) checkpoints iterations 1, 1+N, 1+2N, …
    and skips the HITL `iteration_checkpoint` park on off-cadence
    iterations.
  - `AgentRunConfig.pruneKeepLast?` (default undefined = never prune)
    prunes the run's checkpoint set down to the newest N after each
    iteration-checkpoint create.

- f1f000c: Provider capability negotiation — degradation is now loud, not silent.

  `LLMProvider` gains an optional `readonly capabilities?:
ProviderCapabilities` (with a new `supportsVision?` flag on the type)
  declaring what the DRIVER actually does with a request. Providers that
  declare nothing resolve to the exported
  `PERMISSIVE_PROVIDER_CAPABILITIES` constant (assume everything works —
  exactly the previous behavior), so third-party providers are
  unaffected. `resolveProviderCapabilities(provider)` performs the
  per-field permissive merge.

  `query()` consults the resolved capabilities before tooling bootstrap:

  - Tools registered against a `supportsTools: false` driver → a loud
    `log.warn`, a new `capability_warning` run event, and every tool
    surface stripped (no `<available_tools>` prompt section, no `tools`
    request param) so the model is never told about tools it cannot
    call.
  - Image attachments on user messages against a `supportsVision: false`
    driver → `log.warn` + a `capability_warning` run event so the host
    can surface that the images never reach the model.
  - New `QueryParams.strictCapabilities?: boolean` (default `false`)
    throws on either mismatch instead of degrading.

  `RunEvent` gains the additive `capability_warning` variant
  (`capability: 'tools' | 'vision'`, `providerId`, `message`); the
  SSE/A2A bridges intentionally do not map it to a wire event yet.

### Patch Changes

- 30c755d: Remove the dead task-notification busy-wait that could hang a run for minutes.

  When the model ended its turn while the task gateway still listed a running
  agent task, the iteration loop polled an internal `pendingNotifications`
  queue every 250ms for up to `runConfig.timeoutMs` (120s default) — but
  nothing has pushed onto that queue since the `onTaskCompleted` listener was
  removed: every dispatch tool (`create_task`, `continue_task`, `Agent`) is
  blocking and already returns the worker's output as the dispatching
  tool_use's canonical `tool_result`. The wait always injected nothing, then
  re-invoked the model with an unchanged conversation, so runs with an orphaned
  task (an interrupted tool execution, a cancel race) sporadically stalled for
  multiples of the timeout before finishing with the answer they already had.

  The superseded `<task-notification>` envelope path is now fully torn out
  (`waitAndInjectNotifications`, `injectOneTaskNotification`, the
  `pendingNotifications` queue and its XML/CDATA helpers). End-of-turn
  semantics with orphan running tasks are explicit: the run ends normally
  (`end_turn`) and a warning is logged that the orphans have no delivery path.
  Runs without orphan tasks are byte-identical.

## 1.1.0

### Minor Changes

- ac85934: Add a model-authored `ask_user_question` HITL surface to the coordinator
  toolset. `HITLDecisionRequest` gains a `user_question` variant carrying
  `UserQuestionData` (questionId = the asking `tool_use_id`, question text,
  optional header, 2-4 model-authored options, multiSelect, allowFreeText),
  and `HITLResumeDecision` gains `answer_question` (selectedOptionIds,
  optional freeText, optional questionId echo as a misdirection guard).
  The tool registers only when `buildCoordinatorTools` receives BOTH a
  `resumeHandler` and a `runId` (SupervisorAgent threads its configured
  `resumeHandler` through automatically), parks the run through the same
  ResumeHandler channel as plan approvals, and returns the user's answer
  verbatim as the tool result — selections quote question and labels,
  free text is rendered "in their own words", and an empty/misdirected/
  mismatched answer yields an explicit "the user did not answer" sentinel
  instead of fabricated consent. The tool is deliberately NOT
  concurrency-safe so multiple questions in one assistant turn park
  strictly one at a time against host run-keyed park registries.
  Headless callers degrade safely: `autoApproveHandler` answers
  `user_question` with the no-selection sentinel ("No user is available
  to answer. Proceed using your best judgment."), so runs without an
  interactive ResumeHandler never deadlock and never invent a choice.
  Existing ResumeHandler implementations compile unchanged (additive
  union widening); bare plan-approval and tool-review flows are
  byte-identical.
- 9df35d1: Make a Stop abort the IN-FLIGHT model turn, not only between turns.

  `ChatCompletionParams` gains an optional `signal?: AbortSignal`. The query
  runtime threads the run's abort signal into every provider call (the streaming
  turn and the forced-final summary) and now drives the provider stream through a
  MANUAL iterator that RACES each `next()` against the abort — so a cancellation
  tears the turn down within a tick even if a transport buffers or ignores the
  signal, with the abort propagating out of the generator so the run settles as
  `cancelled`. The stream consumer cleans up on every exit (removes the abort
  listener, calls `iterator.return()`), and the natural-completion break
  re-checks the signal so a Stop that lands exactly as the turn finishes is
  recorded as cancelled rather than a normal end-of-turn.

  Every provider now honours the signal at the transport: Anthropic
  (`messages.create({ signal })`), OpenAI (`create(..., { signal })`), Bedrock
  (`send(..., { abortSignal })`), OpenRouter + HTTP (compose with the request
  timeout via `AbortSignal.any`), Ollama (the returned iterator's `.abort()`),
  and LM Studio (`respond(..., { signal })` → the SDK's websocket cancel) — each
  plus a cheap per-chunk `signal.throwIfAborted()` for promptness.

  Fully additive and inert when unset: a never-aborted signal is behaviourally
  identical to omitting it, so existing callers and uncancelled runs are
  byte-identical.

- 6c09394: Add an optional feedback channel to plan approvals: `HITLResumeDecision`'s
  `approve_plan` variant now carries `feedback?: string`, the plan-approval
  resume handler forwards it as `PlanApprovalResponse.feedback`, and the
  coordinator `approve_plan` tool embeds approve-with-edits feedback in the
  model-visible tool result so the supervisor applies the user's edits
  atomically with the approval. Bare approvals are byte-identical to before;
  existing resume handlers compile and behave unchanged.
- 8c07556: Tool-loading economics: honor prompt caching in the Anthropic provider and
  make deferred-tool discovery ranked and bounded.

  `@namzu/anthropic`:

  - `cacheControl` on `ChatCompletionParams` is now honored (it was silently
    dropped; `cache_read_input_tokens` was always 0). The provider emits up to
    three `cache_control: {type:'ephemeral'}` breakpoints per request: the
    tools-array tail, the last `'cache'`-tagged system block, and the last
    message block (render order tools → system → messages).
  - System messages are sent as a block array preserving `SystemMessage.cacheHint`
    segment boundaries instead of being joined into one string. The OAuth
    Claude Code identity block stays first.
  - `toolChoice: 'none'` now maps to Anthropic's first-class
    `tool_choice: {type:'none'}` instead of `{type:'auto'}`, and `tool_choice`
    is only sent alongside a `tools` param.
  - `parallelToolCalls: false` now maps to `disable_parallel_tool_use: true`
    on the `tool_choice` (previously unmapped).

  `@namzu/sdk`:

  - The runtime keeps the tools param byte-stable on forced-final iterations
    (resource-limit finalization) and forbids tool use via `toolChoice: 'none'`
    instead of omitting `tools` — omitting busted the whole prompt-cache prefix
    and risked a 400 with `tool_use`/`tool_result` blocks in history.
  - `ToolRegistry.toPromptSection()` lists active tools name-only (their
    descriptions and schemas already ride the runtime tools param every
    request) and gives deferred tools a first-sentence hint (≤100 chars) so the
    model can discover what a deferred name does before searching.
  - `ToolRegistry.searchDeferred()` is now a ranked weighted search (exact
    name 12, name substring 8, description 5, argument names 3 — the
    `ToolCatalog.searchTools` weights) with generic CRUD verbs (`list`,
    `read`, `create`, `update`, `get`, `find`, `delete`, `search`) added to the
    stop-token set. `search_tools` activates only the top-5 ranked matches and
    reports up to 5 near-misses as name+hint WITHOUT activating them, so a
    retrieval miss becomes a cheap re-query instead of a dead end. The
    `search_tools` input wire shape (`{query}`) is unchanged.

### Patch Changes

- 999e4be: Context-management correctness fixes (Vandal round-3 architecture audit).

  - **Compaction no longer orphans tool pairs.** `runCompactionCheck` now snaps
    the recent-window boundary through `findSafeTrimIndex` (previously wired only
    to the unused `ConversationManager` strategy classes), so a compaction cut can
    never leave a `tool_result` at the head of the recent window whose `tool_use`
    was summarized away. That orphan otherwise makes the provider reject the very
    next turn with a 400 — compaction killing the long run it exists to keep alive.
  - **Resume preserves the compaction summary + working-memory slot.** The
    checkpoint-restore path used to drop EVERY system message, silently losing the
    `[COMPACTED CONTEXT]` block (the only record of the older history a pass
    deleted) on `resumeFromCheckpoint`. It now re-pushes the fresh static/dynamic
    floor but preserves the compaction summary and the pinned working-memory slot.
  - **Within-turn usage is merged, not last-write-wins.** `mergeTokenUsage`
    (per-field high-water mark) replaces `usage = chunk.usage` in `collect()` and
    the iteration stream reducer, so a late usage frame that omits input/cache
    tokens no longer zeroes the counts captured earlier in the stream.
  - **HITL parks are cancellable.** `awaitDecisionOrAbort` races the tool-review
    and iteration-checkpoint `resumeHandler` parks against the run's abort signal,
    so a Stop that arrives while parked resolves the park as `abort` instead of
    hanging until the host answers. Degrades to a plain await when no controller
    is wired; fails closed to `abort` if the handler rejects.

  All changes are internal correctness fixes; the provider/message wire contract
  is unchanged and existing consumers stay behaviourally identical outside the
  buggy edge cases above.

- 42f577e: Recreate shared run workspace manifest directories before atomic writes.
- 9a0c5ee: Plan-rejection guidance now follows the user's feedback instead of baking in
  an unconditional revise loop. The old output told the supervisor to "revise
  your plan ... and call approve_plan again" even when the feedback explicitly
  asked it to stop, so a rejection meant to halt kept generating new plans.
  The output now instructs: follow the feedback — revise and re-submit only if
  changes were requested; acknowledge and end the turn if asked to stop; ask
  the user how to proceed when no feedback was given.
- 0d1fb7b: Harden file intake and ACI readiness failure handling.

  The built-in read tool now guides Office and PDF packages through
  extractor tooling instead of treating binary document containers as
  UTF-8 text. The ACI Standby Pool backend now deletes a claimed
  container group when IP or worker readiness polling fails before a
  Sandbox handle is returned.

- 2c5dd7a: The supervisor's task ledger no longer fabricates success for workers that
  produced no result. Previously, when a task handle had no `result`, the
  synthesized entry took its status from `handle.state` (cast to a terminal
  type) — so a handle reporting `state: 'completed'` but carrying no result was
  counted toward `completedTasks`. The supervisor then reported "workers done"
  with empty outputs when the workers never actually produced anything.

  An absent result is now always synthesized as a terminal `'failed'`, so it can
  never count as a completed task. Handles that carry a real `result` are
  preserved verbatim, so genuine workers are unaffected. The synthesis and tally
  are extracted into `synthesizeTaskResults` / `countCompletedTasks` and covered
  by unit tests.

- 271e6cf: Accept plain-text `approve_plan` step lists and normalize them into canonical
  step objects before execution. This keeps plan approval cards resilient when a
  provider emits numbered prose instead of an array-shaped argument.
- b776acf: Make the package-version read bundle-safe. `version.ts` read `../package.json`
  via `createRequire(import.meta.url)` at module-init with no guard. esbuild leaves
  `createRequire` calls as runtime requires and collapses the dist tree into a
  single file, so in a bundle `../package.json` no longer resolves and the read
  threw at import time — crashing the whole process on any code path that touches
  the SDK runtime (`Cannot find module '../package.json'`). Wrap the read in
  try/catch with a `0.0.0` fallback, mirroring the CLI's existing
  `readPackageVersion`. Unbundled behaviour is unchanged (real version is read);
  a bundled build degrades the cosmetic version string instead of crashing.

## 1.0.0

### Major Changes

- df09910: fix(sdk)!: drop plan-task lifecycle from `buildAgentTool`

  `buildAgentTool` used to auto-create a plan task in the supplied
  `taskStore` and flip it to `'in_progress'` before invoking the
  subagent. On success it flipped to `'completed'`, but on failure
  the plan task was left stuck in `'in_progress'` forever — the
  `TaskStatus` enum has no `'failed'` value to transition to, so
  there was no honest way to close it from inside the tool.

  Removed `taskStore` and `runId` from `AgentToolOptions` entirely.
  The `Agent` tool's job is "invoke a subagent and return the
  result"; plan-task tracking is the parent's responsibility via
  `TaskCreate` / `TaskUpdate`, where the host owns the status
  semantics. This avoids the leak class entirely instead of
  patching it.

  Breaking change for any consumer that was relying on the auto-
  plan-task behaviour. Migrate by creating the plan task on the
  host side before calling `Agent`, and updating it on the host
  side once the tool result is in hand.

- ea21863: feat(sdk)!: rename builtin tools to Claude Code canonical names

  **Breaking change.** Builtin tool names now mirror Claude Code's canonical
  tool table verbatim (per `code.claude.com/docs/en/tools-reference`):

  - `bash` → `Bash`
  - `edit` → `Edit`
  - `glob` → `Glob`
  - `grep` → `Grep`
  - `read_file` → `Read`
  - `write_file` → `Write`

  `LsTool` and `SearchToolsTool` are still exported but **removed from the
  default `getBuiltinTools()` set**. Claude Code's training distribution
  does not include `LS` (directory listing is `Bash` + `Glob`) and has no
  `search_tools` analogue at all. Including them in the defaults gave the
  model two tools that looked right but degraded alignment. Hosts that
  genuinely want either can register them explicitly.

  Why this is breaking and worth it: Namzu is a peer to Claude Code's
  native agentic surface, not a wrapper around the Anthropic Beta Agents
  API. Mirroring the canonical names verbatim means Claude's pretrained
  agentic instincts apply for free — no system-prompt argument needed to
  explain what `Read` or `Bash` does. Idiosyncratic snake_case names threw
  that alignment away on every call.

  **Migration:** consumers that hard-code tool-name strings in their
  prompt overlays, friendly-label maps, or per-tool deny rules need to
  update them to the new PascalCase names. The runtime registry contracts
  (register / get / has) are unchanged; only the literal string names of
  the builtin tools moved.

- 8fd9349: feat(sandbox)!: Anthropic-style multi-mount container sandbox layout

  Adds a declarative `ContainerSandboxLayout` shape that maps onto
  Anthropic's container architecture (Claude container blueprint,
  Code Interpreter, "skills"). The `Container` prefix is load-bearing
  — this layout is specific to the container tier; future microVM /
  process tiers will carry their own layout types when their adapters
  land. Layout is supplied at provider construction — not per
  `provider.create()` call — so the type system catches missing-layout
  mistakes at compile time:

  ```ts
  import {
    createSandboxProvider,
    SANDBOX_DEFAULT_OUTPUTS_PATH, // re-exported from @namzu/sdk
  } from "@namzu/sandbox";

  const provider = createSandboxProvider({
    backend: { tier: "container", image: "namzu-worker:latest" },
    layout: {
      outputs: {
        source: {
          type: "hostDir",
          hostPath: "/var/lib/vandal/sessions/<task>/outputs",
        },
      },
      uploads: {
        source: {
          type: "hostDir",
          hostPath: "/var/lib/vandal/sessions/<task>/uploads",
        },
      },
      skills: [
        {
          id: "pdf-tools",
          source: { type: "hostDir", hostPath: "/opt/skills/pdf-tools" },
        },
      ],
    },
  });
  ```

  Each mount carries a discriminated `ContainerSandboxMountSource`.
  The single variant today is `{ type: 'hostDir'; hostPath: string }`;
  future variants (squashfs skill bundles, managed volumes attached
  to a container backend) land additively as minor bumps without
  reshaping the consumer call site.

  Layout fields and their defaults:

  - `outputs` — RW. Default `/mnt/user-data/outputs`. **Required**.
  - `uploads` — RO. Default `/mnt/user-data/uploads`.
  - `toolResults` — RO. Default `/mnt/user-data/tool_results`.
  - `skills` — RO list, default `/mnt/skills/<id>` per entry.
  - `transcripts` — RO. Default `/mnt/transcripts`.

  The defaults are exported as constants from `@namzu/sdk`'s root
  barrel (`SANDBOX_DEFAULT_OUTPUTS_PATH`,
  `SANDBOX_DEFAULT_UPLOADS_PATH`, `SANDBOX_DEFAULT_TOOL_RESULTS_PATH`,
  `SANDBOX_DEFAULT_TRANSCRIPTS_PATH`, `SANDBOX_DEFAULT_SKILLS_PARENT`)
  and re-exported from `@namzu/sandbox`, so prompt-template generators
  and the backend agree on a single source of truth. Both import
  paths (`@namzu/sdk` and `@namzu/sandbox`) are pinned by tests.

  There is intentionally **no `scratchpad` field**: the
  container-internal RW area (`/home/<imageUser>`) is image-bake
  responsibility, not a runtime knob.

  **Validation** runs synchronously inside `createSandboxProvider` and
  collects every violation in one
  `ContainerSandboxLayoutValidationError.reasons[]`:

  - `outputs` must be present.
  - Skill IDs match `/^[a-zA-Z0-9_.-]+$/`, and `id.includes('..')` is
    rejected (path-traversal guard — covers `..`, `foo..bar`,
    `..foo`, `foo..`). Isolated dots (`pdf-tools.v2`) pass.
  - Skill IDs are unique.
  - Resolved `containerPath`s are unique across every mount slot.

  **Error transport.** `ContainerSandboxLayoutValidationError`
  carries a `cause` field (Error native), `toJSON()` keeps `reasons`
  (and `cause` when set), and a new helper
  `serializeSandboxError(err: unknown): SerializedSandboxError`
  returns a plain object that survives `structuredClone`,
  `postMessage`, and `JSON.stringify` round-trips uniformly. The
  helper is **cycle-safe** — a `WeakSet`-threaded recursion detects
  self-cycles (`a.cause = a`), two-node cycles (`a.cause = b;
b.cause = a`), and longer loops, replacing the offending node with
  a `{ name: 'CircularReference', message: '[circular]' }` sentinel
  rather than overflowing the stack. The helper is also
  **transport-safe** — non-Error causes (Function, Symbol, BigInt,
  NaN, ±Infinity, undefined, null, primitives, plain objects) are
  converted to a typed envelope by `serializeNonErrorCause` BEFORE
  they enter the wire shape, so values that `JSON.stringify` drops
  silently or `structuredClone` throws on never appear.
  `SerializedSandboxError.cause` is strictly typed
  `SerializedSandboxError | undefined`. Use the helper at any
  worker / IPC / log-shipper boundary; cloning the Error subclass
  itself is not supported.

  **Breaking changes** — the legacy single-mount paradigm is removed:

  - `SandboxCreateConfig.hostWorkspaceDir` is removed. Pass the host
    path on `layout.outputs.source.hostPath` at provider construction.
  - `ContainerBackendConfig.workspaceMount` is removed. Pass the
    in-container path on `layout.outputs.containerPath`.
  - `SandboxProviderConfig` is now a discriminated union: the
    container variant requires `layout: ContainerSandboxLayout`, the
    other variants do not carry the field. Constructing a docker
    provider without a layout fails at compile time.
  - `SandboxCreateConfig.layout` does NOT exist; layout is
    factory-baked. The SDK runtime cannot accidentally call a
    container provider without a layout.
  - The docker backend no longer allocates host directories
    (`mkdtemp`) or removes them on `destroy()`. Every bind source is
    consumer-owned. This also fixes an `EACCES: permission denied,
mkdir '/Users'` crash that hit sibling-container deployments
    (Vandal Cowork).
  - The worker no longer reads `NAMZU_SANDBOX_LAYOUT` (it never
    branched on the env, only logged it; size grew with the skill
    list). Only `NAMZU_SANDBOX_WORKSPACE` is forwarded today.

  The reference Dockerfile pre-creates **only the parent directories**
  `/mnt`, `/mnt/user-data`, `/mnt/skills` — root-owned, mode 0555.
  Leaf paths (`outputs/`, `uploads/`, `tool_results/`, `transcripts/`,
  `<skill-id>/`) are intentionally NOT pre-created. When a bind is
  attached the docker daemon creates the leaf as the bind target;
  when not attached, the leaf does not exist — the model gets ENOENT
  instead of an empty writable dir that looks "mounted but uploaded
  nothing".

  `pnpm sandbox:smoke` (alias for `pnpm --filter @namzu/sandbox
test:smoke`) runs an opt-in docker integration test exercising the
  leaf-permission contract against a real docker daemon. Excluded
  from the default `pnpm test`; gated by a dedicated
  `.github/workflows/sandbox-smoke.yml` workflow that builds the
  reference image and runs the smoke test on PR / push when the
  sandbox surface changes. On CI (`process.env.CI === 'true'`), the
  smoke test fails fast if docker / the image are absent rather than
  silently skipping.

  `@namzu/sdk` exports `ContainerSandboxLayout`,
  `ContainerSandboxLayoutMount`, `ContainerSandboxMountSource`,
  `ContainerSandboxSkillMount`, `ResolvedContainerSandboxLayout`,
  and the five `SANDBOX_DEFAULT_*_PATH` constants from its root
  barrel. `@namzu/sandbox` re-exports those names plus
  `ContainerSandboxLayoutValidationError`, `serializeSandboxError`,
  and the `SerializedSandboxError` shape. The packed-tarball shape
  is verified by `.github/scripts/verify-consumer-install.sh`'s
  `@namzu/sandbox public-surface fixture`, which installs the
  package from a tarball into a clean project and asserts every
  documented constant + runtime export comes back via both
  `@namzu/sandbox` and `@namzu/sdk` import paths. `@namzu/sandbox`
  is also added to `ci.yml`'s `publint` and ATTW (Are The Types
  Wrong) gates.

### Minor Changes

- 542f057: feat(sdk): canonical `Agent` tool for synchronous subagent delegation

  Adds `buildAgentTool({ gateway, workingDirectory, allowedAgentIds, ... })`
  that builds a single tool named `Agent` with the input shape
  `{ description, prompt, subagent_type }`. This mirrors Claude Code's
  training distribution verbatim (per `code.claude.com/docs/en/sub-agents`):
  the parent's tool call BLOCKS on `gateway.waitForTask(handle.taskId)`,
  the subagent runs in its own context window, and the subagent's final
  text comes back as the tool result.

  Why this matters: the existing `buildCoordinatorTools` shipped a
  non-blocking `create_task` / `continue_task` / `cancel_task` trio that
  returned immediately and surfaced subagent completion via a
  `<task-notification>` callback. That pattern is useful for fire-and-
  forget multi-task fan-out but is **not** what Claude was trained on.
  Models calling the async coordinator tools waste tokens reasoning
  about whether the task completed yet; with the canonical `Agent`
  tool, the model just receives the result and continues. Free
  alignment, no system-prompt argument needed.

  Both surfaces remain available — the coordinator trio is the right
  choice for genuine work-queue surfaces, the `Agent` tool is the
  right choice when the host wants Claude Code parity.

- 265150b: feat(sdk): default sandboxed verification gate preset + expanded brick-pattern denylist

  Ship `defaultSandboxedGateConfig()` and `defaultSandboxedShellGateConfig()` from `@namzu/sdk` so
  hosts running an agent inside an isolated workspace don't have to hand-roll a `VerificationRule[]`
  just to keep in-sandbox file mutation from triggering a review prompt on every call. The first
  preset auto-allows read-only tools and `category: 'filesystem' | 'analysis' | 'custom'`; the
  second extends auto-allow to `category: 'shell'` for hosts with real OS-level isolation. Both
  keep the dangerous-patterns hard-deny in place.

  `DANGEROUS_PATTERNS` (consumed by the `deny_dangerous_patterns` rule) gains entries for `sudo`,
  `su -`, world-writable `chmod 777 /`, `curl|sh` / `wget|sh` exfil-then-exec pipes, outbound
  `ssh user@host`, and raw dynamic `eval`. The list is still high-signal, not exhaustive — the
  README in `verification/presets.ts` is explicit that the sandbox itself is the safety boundary
  and the patterns only catch blatant attempts.

- 52af97e: **Paste images into the conversation (vision input).**

  A user message can now carry image attachments. `@namzu/sdk` adds an optional `attachments` field to user messages (`ImageAttachment { data, mediaType }`, additive — text messages are unchanged), and the Anthropic provider sends them as image content blocks so the model can see them. In the CLI, press `Ctrl+V` to paste an image from the clipboard — it shows as an `⎘ Image #N` chip in the composer and is sent to the model as vision input when you submit.

- a71422a: feat(sdk): ReactiveAgent forwards verificationGate to drainQuery

  Adds an optional `verificationGate?: VerificationGateConfig` field on
  `ReactiveAgentConfig` and forwards it through `ReactiveAgent.run()` into
  `drainQuery`, mirroring the existing `SupervisorAgentConfig.verificationGate`
  plumbing. Without this, child agents running under `ReactiveAgent` could not
  opt into the same capability-aware deny/allow rules the supervisor already
  uses — the only path was `drainQuery`'s `autoApproveHandler` default, which
  approves every tool call silently. Hosts that want defense-in-depth at the
  child level (deny dangerous shell patterns, restrict by category) can now
  pass the same preset they pass to the supervisor.

- d6b5bc1: **Remove the legacy `append` file tool.** `AppendFileTool` is gone — it was already excluded from `getBuiltinTools()` (Claude Code's tool distribution has no `Append`), and appending is canonical `edit` with `insertLine: "end"`. The export is removed from the public surface; hosts that relied on it should switch to `edit`. namzu's CLI no longer needs to filter `append` out of its tool set.
- 63b4885: feat(sdk): forward sandboxProvider through reactive/supervisor agents

  `ReactiveAgentConfig` and `SupervisorAgentConfig` gain an optional
  `sandboxProvider?: SandboxProvider` field. When set, the agent's
  `runConfig` builder forwards the provider into `drainQuery`'s
  `sandboxProvider` slot, so the supervisor — and every child
  specialist run that inherits the supervisor's run config — gets
  the same per-task ephemeral container.

  Without this plumbing, a host that wires `sandboxProvider` only on
  the supervisor sees the field silently dropped before child
  specialists are spawned, and each child runs without a sandbox.
  The forwarding closes that gap so multi-agent hosts can pass a
  single per-task provider instance and have supervisor + every
  child share one container.

  Pure additive change — `SupervisorAgent` / `ReactiveAgent`
  constructors that don't pass `sandboxProvider` behave exactly as
  before.

- d86b161: **namzu can now delegate to sub-agents.**

  The CLI wires the SDK's native delegation: the model gets the canonical `Agent({ description, prompt, subagent_type })` tool and can hand a self-contained task to a fresh `general-purpose` sub-agent that runs in its own context window with its own tools, then returns its result. Delegations show in the transcript as a normal `Agent(...)` tool call with a live spinner and result.

  To support this from a host, `@namzu/sdk` now exports `ThreadManager` and `InMemoryThreadStore` from its public runtime surface (alongside the already-public `AgentManager`, `AgentRegistry`, `ReactiveAgent`, `LocalTaskGateway`, `buildAgentTool`, and the session/summary/capacity/workspace primitives) so a consumer can stand up an `AgentManager` end to end.

### Patch Changes

- 140bcc0: fix(sdk): Agent tool no longer reports failed subagents as successful

  `buildAgentTool` was treating `gateway.waitForTask(handle.taskId)`'s
  returned `state === 'completed'` as proof of success and ignoring
  the underlying `BaseAgentResult.status`. That was wrong: some
  gateways (the SDK's `LocalTaskGateway` for one) forward
  `task.state` directly from the agent manager without re-deriving it
  from the run's `status`, so a subagent run with `status: 'failed'`
  plus a non-empty `lastError` could surface as `state: 'completed'`
  and fool the parent into receiving `success: true` with garbage
  output.

  The check now requires BOTH layers to agree before reporting
  success: gateway state must be `'completed'` AND the run's
  `BaseAgentResult.status` (when present) must be `'completed'`. On
  failure the tool surfaces `lastError` and the disagreement state in
  both `error` and `data` so the parent can debug.

  Adds three pinned cases in
  `packages/sdk/src/tools/coordinator/__tests__/agent.test.ts`
  covering: both-agree-success, run-status-failed-but-state-completed
  (the regression case), and gateway-state-failed.

- 38c4b62: Harden two paths flagged by an adversarial review: `ToolRegistry.searchDeferred` no longer over-activates deferred tools — batched-query tokens match the tool name only (not descriptions) and short/generic tokens like `clawtool` are ignored, so a common word can't activate the whole catalog. The dynamic `Agent` sub-agent now unregisters its per-call `dyn-N` definition in a `finally`, so long sessions don't leak persona registrations on success, failure, or throw.
- a1c6694: **Fix a race when multiple file-mutating tools run in one turn.**

  The tool executor ran every tool call in a batch with `Promise.all`, ignoring each tool's `concurrencySafe` flag. Several `edit`/`write` calls to the same file in one assistant turn therefore raced on read→modify→write — each read the same starting content and the last writer clobbered the others, even though every call reported success. The executor now honors `concurrencySafe`: read-only tools (ls/grep/glob/…) still run in parallel, but concurrency-unsafe tools (edit/write/append/bash) are serialized within the batch, so same-file edits apply one-after-another.

- 63e44f7: Worker `handleExecute` no longer crashes the per-task container when a
  single request body is rejected by `resolveWithinWorkspace` (e.g. a host
  path forwarded as `cwd`) or by the workspace `mkdir`. Each fallible step
  now returns a typed `400` (or a terminal NDJSON `error` event for
  post-headers failures) and the worker stays alive for the next call —
  prior behaviour was an unhandled rejection on the `http.createServer`
  callback, which on Node ≥ 15 exits the process and gives every
  subsequent SDK call the bare `fetch failed` from `UND_ERR_SOCKET`.

  The docker backend's host-side `execViaWorker` and `writeFile` fetches
  now surface `error.cause.code` / `cause.message` instead of the
  stripped `fetch failed`. The bash builtin no longer forwards
  `context.workingDirectory` (a host-side path that has no meaning
  inside the sandbox container) as `cwd`; tools that need a sub-cwd
  inside the sandbox can be added later via an explicit
  `SandboxExecOptions` field.

  The SDK's iteration aggregator now derives
  `ChatCompletionResponse.toolCalls[i].function.arguments` from each
  bucket's parsed input rather than the raw `argsBuf` buffer. When a
  provider stream truncates with `stop_reason: "max_tokens"` mid-
  `input_json_delta`, downstream `JSON.parse` in
  `runtime/query/executor.ts:executeSingle` no longer rejects with the
  generic "Invalid JSON in tool arguments" — the tool runs against the
  empty parsed object and the input zod schema produces a readable
  "<field> is required" error instead.

- 38c4b62: Fix `search_tools` failing to load deferred tools when the model names several at once. `ToolRegistry.searchDeferred` matched the entire query as a single substring, so a batched query like `"A2aCard PeerRegister PeerList"` matched no tool and activated nothing — the subsequent call then failed with "deferred and cannot be executed". The query is now tokenized: a tool matches if its name or description contains the whole phrase OR any single term, so a batch activates each named tool.
- 6b74cd0: **Sub-agents do real work, and tool tracking is keyed on the SDK's tool-use id.**

  - Sub-agents now get the same tool set as the parent — builtins, memory, and clawtool's catalog (deferred, incl. web search/fetch and peer dispatch) — so a delegated research/work task can actually use tools instead of answering from memory alone.
  - The transcript's live tool tracking now matches each call by the SDK's stable `toolUseId` rather than by name/order, so parallel tool calls (even same-named) are attributed correctly.
  - Stronger anti-fabrication instruction for both the main agent and sub-agents: never claim to have run a tool, written a file, or produced a result without actually doing it; if a capability is unavailable, say so instead of inventing output.
  - `@namzu/sdk`: the `Agent` tool's `subagent_type` is now optional when only one sub-agent is registered (defaults to it), so the model can't trip a "subagent_type required" validation error on the common single-sub-agent setup.

## 0.6.0

### Minor Changes

- 1df23b1: `SupervisorAgentConfig` accepts `resumeHandler` and `verificationGate`.

  The supervisor's existing tool-review pipeline (drainQuery's
  `runToolReview` phase) was reachable only by callers that constructed
  `drainQuery` arguments by hand — `SupervisorAgent.run` ignored them
  entirely and always fell back to `autoApproveHandler`. Hosts that
  wanted "Ask before acting" semantics had no way to plug in.

  `SupervisorAgent.run` now forwards both fields verbatim to
  `drainQuery` when the caller supplies them. Behaviour is unchanged
  for callers that omit them — the SDK still defaults to auto-approve.

  Migration:

  ```ts
  new SupervisorAgent({...}).run(input, {
    ...config,
    // surface tool_review_requested events to the user; resolve when
    // they approve / modify / reject.
    resumeHandler: async ({ runId, toolCalls, ... }) => {
      return await waitForUserDecision(runId, toolCalls)
    },
    // optionally pre-classify tools so trivial reads bypass review.
    verificationGate: { enabled: true, rules: [...] },
  })
  ```

## 0.5.0

### Minor Changes

- 2749d32: RunEvent v3 + streaming-only `LLMProvider` (ses_001-tool-stream-events).

  The kernel now emits a per-message and per-tool-input lifecycle on the
  event bus, and the provider contract collapses to a single streaming
  entry point. Together these unlock live tool-call rendering (Calling →
  Running → Done with incremental input) for SSE consumers — the cowork
  workspace surface that motivated the work in the first place.

  ## Breaking changes

  ### `LLMProvider.chat()` removed

  `LLMProvider` exposes a single LLM entry point: `chatStream()`. The
  non-streaming `chat()` method is gone from every shipped provider
  (`@namzu/anthropic`, `@namzu/openai`, `@namzu/bedrock`,
  `@namzu/openrouter`, `@namzu/http`, `@namzu/ollama`,
  `@namzu/lmstudio`).

  Consumers that need an aggregated `ChatCompletionResponse` use the new
  helper:

  ```ts
  import { collect } from "@namzu/sdk";

  const response = await collect(provider.chatStream(params));
  ```

  `collect()` drains the stream and assembles the legacy response shape:
  text concatenated in arrival order, tool calls bucketed by index,
  latest `finishReason` and `usage` win, defaults to `{ finishReason:
'stop', zero usage }` when the provider omits them (defensive against
  SDK quirks like dropped `message_stop` frames).

  The orchestrator consumes the stream directly so it can emit per-delta
  RunEvents — it does NOT call `collect()`.

  ### `RunEvent` envelope `schemaVersion: 2 → 3`

  `RUN_EVENT_SCHEMA_VERSION` is now `3`. The envelope narrows from `2 |
3` to `3`; sub-session lifecycle events stamp `3` automatically via
  `RunEventSchemaVersion`.

  ### `llm_response` removed

  The coarse `llm_response` event is replaced by a message lifecycle:

  - `message_started { runId, iteration, messageId }` — first chunk arrives.
  - `text_delta { runId, iteration, messageId, text }` — per-chunk text.
  - `message_completed { runId, iteration, messageId, stopReason, usage?, content? }` — provider stream closes.

  `message_completed.content` is the aggregated text and is optional —
  consumers that already accumulate `text_delta` themselves can ignore
  it; consumers that only care about the completed message (telemetry,
  A2A bridge) read it directly.

  `stopReason` is the new `MessageStopReason` union: `'end_turn' |
'tool_use' | 'max_tokens' | 'stop_sequence' | 'pause_turn' | 'refusal'
| 'forced_finalize'`.

  ### Tool input lifecycle

  Tool calls now traverse a five-event lifecycle keyed by `toolUseId`:

  - `tool_input_started { runId, iteration, messageId, toolUseId, toolName }`
  - `tool_input_delta { runId, toolUseId, partialJson }` — raw fragment
  - `tool_input_completed { runId, toolUseId, input }` — parsed object
  - `tool_executing { runId, toolUseId, toolName, input }` — runtime invokes
  - `tool_completed { runId, toolUseId, toolName, result, isError }` — required `isError`

  `tool_executing` and `tool_completed` payloads tighten: `toolUseId`
  becomes required on both, `isError` becomes required on
  `tool_completed`. The wire-level `tool.error` event is dropped — the
  boolean carries the same signal without ambiguity.

  Probe veto, malformed JSON args, plugin hook errors, and exception
  throws inside `tools.execute()` all now emit a terminal
  `tool_completed { isError: true }` so consumer UI cards can finalise
  instead of being orphaned.

  ### Ephemeral events skip persistence

  `text_delta` and `tool_input_delta` are flagged `isEphemeralEvent()`
  and bypass `transcript.jsonl`. They live only on the in-memory bus
  for live UI rendering. Replay is unaffected (it reads checkpoints,
  not transcripts). The bus has a 1000-event soft cap; under pressure
  the oldest ephemeral is dropped while lifecycle events are preserved.

  ### `StreamChunk.delta.toolCallEnd`

  New optional field signalling per-tool-block boundary closure. The
  orchestrator translates it into `tool_input_completed`. Providers
  that emit a per-tool-block close (Anthropic `content_block_stop` of
  type `tool_use`, Bedrock equivalent) populate it; providers that
  don't fall back to end-of-stream flushing.

  ## Migration

  Most consumers only use the iteration orchestrator's emitted
  `RunEvent` stream. They:

  1. Replace `case 'llm_response':` handlers with a `case
'message_completed':` handler reading `event.content`.
  2. Drop any reads of `event.hasToolCalls` — derive from the
     subsequent absence/presence of `tool_executing` events keyed by
     the same `runId`.
  3. Optional: subscribe to `text_delta` and `tool_input_*` for live
     rendering. The events are interleaved by `toolUseId` to support
     parallel tool calls.

  Consumers calling `provider.chat()` directly:

  ```diff
  - const response = await provider.chat(params)
  + import { collect } from '@namzu/sdk'
  + const response = await collect(provider.chatStream(params))
  ```

  Aggregated response shape is identical.

  ## Internal surface (not externally consumed)

  - `runtime/query/iteration/index.ts` — new `streamProviderTurn()`
    helper, replaces synthesised `message_started`/`message_completed`
    with native streaming. `forced_finalize` path uses `collect()`.
  - `provider/instrumentation.ts` — captures `usage` from the last
    chunk that supplies one (`extractStreamUsage`).
  - `runtime/query/events.ts` — `EventTranslator.emitEvent` skips
    `appendEvent()` for ephemeral events, applies the queue cap.
  - `bridge/sse/mapper.ts` — six new wire types
    (`message.created/delta/completed`,
    `tool.input_started/delta/completed`); `tool.error` removed;
    `tool.executing/completed` carry `tool_use_id` + `is_error`.
  - `bridge/a2a/mapper.ts` — `message_completed.content` routes to A2A
    status update, replacing the per-iteration `llm_response` mapping.

  ## Tests

  SDK suite at 958 (was 943 + new contracts − removed
  `chat()`/`llm_response` invariants). `pnpm typecheck && pnpm lint &&
pnpm test && pnpm build` all green across every package. The
  `@namzu/http` request-construction and response-parsing suites have
  10 tests marked `.skip` pending an SSE-mock rewrite — the streaming
  path is still covered by the existing streaming-suite tests.

## 0.4.5

### Patch Changes

- aead3a8: Doctor registry runtime + 5 built-in checks — ses_007 Phase 4.

  `runDoctor(opts?)` aggregates registered checks into a `DoctorReport` with per-check status + summary + sysexits exit code. `registerDoctorCheck(check)` is the programmatic registration entry point.

  **New runtime exports (12 names):**

  - `doctor` (singleton `DoctorRegistry`), `DoctorRegistry`, `createDoctorRegistry`
  - `registerDoctorCheck(check)` — programmatic registration
  - `runDoctor(opts?)` → `Promise<DoctorReport>`
  - `builtInDoctorChecks` — readonly list of the six shipped checks
  - Six individual built-in checks: `sandboxPlatformCheck`, `cwdWritableCheck`, `tmpdirWritableCheck`, `vaultRegisteredCheck`, `providersRegisteredCheck`, `telemetryInstalledCheck`

  **LLMProvider interface gains optional `doctorCheck?(): Promise<DoctorCheckResult>`.** Non-breaking — existing providers don't need to implement it. Consumers wanting provider health probes register a custom check that walks `ProviderRegistry.getAll()` and calls `provider.doctorCheck?.()` per provider.

  **Built-in checks ship intentionally conservative for v1.** `sandbox.platform` passes on darwin if `/usr/bin/sandbox-exec` is executable; inconclusive on linux (proc namespace probe deferred); warn on win32; inconclusive elsewhere. `runtime.cwd-writable` + `runtime.tmpdir-writable` are real `fs.access(W_OK)` probes. `telemetry.installed` dynamic-imports `@namzu/telemetry` (specifier-variable to evade TS resolution since SDK doesn't depend on telemetry); pass if installed, inconclusive if not. `vault.registered` + `providers.registered` are intentionally inconclusive with explicit "register your own check" guidance — vault and provider registries are module-private and aren't auto-discoverable from a standalone process.

  **Failure isolation:** a thrown check is recorded as `fail` with the throw message; other checks still run. A check exceeding `perCheckTimeoutMs` (default 5000ms) becomes `inconclusive`. Wall-clock timeout (default 10000ms) marks not-yet-completed checks as `inconclusive`. Status set: `pass | fail | inconclusive | warn`. Only `fail` affects the exit code (1); `inconclusive` and `warn` are informational. Empty registry → exit 2 (no config).

  **Embedded usage today, CLI command in the next patch.** Consumers can `import { runDoctor, registerDoctorCheck } from '@namzu/sdk'` and integrate the doctor in their own process where their checks have already executed. The standalone `namzu doctor` CLI command lands in the next patch (Phase 5).

- 8f076e5: ses_007 Phase 5 — doctor runtime moved from `@namzu/sdk` to `@namzu/cli`. Architectural pivot: kernel = SDK (pure runtime primitives), operator surface = CLI (presentation + tooling).

  ## Breaking changes — `@namzu/sdk`

  The following 12 runtime exports have been **removed** from `@namzu/sdk`. They now live in `@namzu/cli`:

  - `doctor` (singleton), `DoctorRegistry`, `createDoctorRegistry`
  - `registerDoctorCheck`, `runDoctor`
  - `builtInDoctorChecks`
  - `sandboxPlatformCheck`, `cwdWritableCheck`, `tmpdirWritableCheck`
  - `vaultRegisteredCheck`, `providersRegisteredCheck`, `telemetryInstalledCheck`

  The `RunDoctorOptions` type has also been removed from `@namzu/sdk` exports.

  **What stays in `@namzu/sdk`:**

  - The protocol types — `DoctorCheck`, `DoctorCheckResult`, `DoctorCheckContext`, `DoctorCheckRecord`, `DoctorReport`, `DoctorStatus`, `DoctorCategory` — remain in `types/doctor/` so kernel components can implement custom checks against them.
  - `LLMProvider.doctorCheck?(): Promise<DoctorCheckResult>` — the kernel hook that lets a provider expose its own healthcheck stays on the interface.

  ## Migration

  If you were calling the doctor in your own process:

  ```diff
  - import { runDoctor, registerDoctorCheck } from '@namzu/sdk'
  + import { runDoctor, registerDoctorCheck } from '@namzu/cli'
  ```

  If you were running it from the command line:

  ```bash
  # Before — required a custom CLI bin or `pnpm dlx tsx packages/sdk/src/doctor/...`
  # After:
  pnpm dlx @namzu/cli doctor
  # or, after install: namzu doctor
  ```

  Custom check authors continue to import the protocol types from `@namzu/sdk`:

  ```ts
  import type { DoctorCheck, DoctorCheckResult } from "@namzu/sdk";
  import { registerDoctorCheck } from "@namzu/cli";

  const myCheck: DoctorCheck = {
    id: "app.db.reachable",
    category: "custom",
    run: async (): Promise<DoctorCheckResult> => {
      // your probe
    },
  };
  registerDoctorCheck(myCheck);
  ```

  ## New — `@namzu/cli` (initial public release)

  `@namzu/cli` v0.1.0 ships as a public package for the first time. Dual-purpose:

  - **Standalone bin** — `npx @namzu/cli doctor`, or after install: `namzu doctor`. Supports `--json`, `--verbose`, `--category <a,b,c>`, `--per-check-timeout <ms>`, `--wall-clock-timeout <ms>`. Sysexits-aligned exit codes (`0` ok, `1` fail, `2` no config, `70` internal error).
  - **Library** — `import { runDoctor, registerDoctorCheck, builtInDoctorChecks } from '@namzu/cli'` for embedded usage where consumer code wants to invoke the doctor in its own process so app-registered checks are visible.

  **What ships built-in:**

  - `sandbox.platform` (darwin sandbox-exec presence + win32 warn + linux/other inconclusive)
  - `runtime.cwd-writable` + `runtime.tmpdir-writable` (real `fs.access(W_OK)` probes)
  - `telemetry.installed` (dynamic-import probe for `@namzu/telemetry`)
  - `vault.registered` + `providers.registered` (intentionally inconclusive — consumers register their own walking their setup)

  **Why patch-bump-equivalent:** `@namzu/sdk: minor` carries the breaking removal (pre-1.0 cadence); `@namzu/cli: minor` carries the new package's first feature release. Together they make the next release a coordinated cut.

## 0.4.4

### Patch Changes

- ffe516c: Probe layer (typed observation + narrow veto) over AgentBus + RunEvent stream — ses_007 phases 0–3.

  Public surface additions:

  - **Typed probe observation.** `probe.on(kind | kind[], handler, opts?)` registers a typed handler scoped to one or more event kinds. `probe.onAny(handler, opts?)` is the catch-all tier preserving legacy `AgentBus.on` semantics. Options: `{ where, priority, name, override }`. Events are frozen at the registry boundary; throws are isolated per probe.
  - **Narrow veto on tool execution.** `probe.veto('tool_executing', handler, opts?)` registers a veto handler. Handler returns `'allow' | 'deny' | { action: 'deny', reason }`. `VetoableEventKind = 'tool_executing'` in v1 (additive minor adds more kinds later). First-deny wins by ascending priority; subsequent veto handlers still fire for audit. Tool executor short-circuits before `tools.execute(...)` on deny: returns a synthetic tool failure carrying `ProbeVetoError.message` so the LLM sees a normal tool-call failure with the probe name + reason.
  - **5 new bus event variants.** `provider_call_start`, `provider_call_completed`, `provider_call_failed`, `vault_lookup`, `sandbox_decision`. Joined to the existing `AgentBusEvent` discriminated union. Snake_case real discriminants — no rename pass on existing events.
  - **Opt-in instrumentation wrappers.** `wrapProviderWithProbes(provider, opts?)` returns an `LLMProvider` that emits `provider_call_*` around every `chat`/`chatStream` call (correlated by a `pcall_${string}` callId, with optional usage telemetry). `wrapVaultWithProbes(vault, opts?)` emits `vault_lookup` on every `retrieve()`; the secret value is never included in the event payload (covered by a "no leakage" test).
  - **First-time public exposure of bus event types.** `AgentBusEvent`, `AgentBusEventListener`, `CircuitBreakerSnapshot`, `FileLock`, etc. were already reachable via `AgentBus.on(listener)` at runtime but couldn't be statically typed by consumers. Now in `public-types.ts`. Pre-existing duplicate `LockId` declaration in `types/bus/` was deduplicated to a re-export from `types/ids/` in passing.
  - **Replay-aware probe context.** `ProbeContext.isReplay: boolean` flag wired through `buildProbeContext({ runId?, isReplay? })` so probes that bill or call external services can opt out on replayed runs (`ctx.isReplay === true`). Replay-execution wiring lands in a future session; the accessor is ready.

  Integration:

  - `AgentBus.emit` dispatches through `ProbeRegistry` first (typed-priority probes → legacy `bus.on` listeners → `onAny` catch-all). Existing `bus.on(listener)` consumers see every event in unchanged relative order.
  - `EventTranslator.emitEvent` dispatches every `RunEvent` through the same registry before the existing pendingEvents push + persist flow.
  - `ToolExecutor.executeSingle` calls `probes.queryVeto({type: 'tool_executing', ...})` immediately after the existing `tool_executing` emit, before `tools.execute(...)`.

  Not yet wired (follow-up commits):

  - Per-run probes via `createRun({ probes: [...] })` — the registry has the foundation; createRun plumbing lands in a follow-up.
  - `wrapProviderWithProbes` / `wrapVaultWithProbes` are opt-in helpers; the SDK's own `ProviderRegistry` does not auto-wrap registered providers yet.
  - `sandbox_decision` ships as a type only; emit site lands when a real sandbox provider exists (current `LocalSandboxProvider` is a stub).

  Public surface delta: `380 → 392` runtime keys (verified against the regenerated baseline). Net new symbols added by this changeset:

  - `probe`, `ProbeRegistry`, `createProbeRegistry`, `buildProbeContext`, `ProbeNameCollisionError`, `ProbeVetoError`
  - `wrapProviderWithProbes`, `wrapVaultWithProbes`

  Non-runtime (types-only) additions: `ProbeEventKind`, `ProbeEventOf<K>`, `ProbeContext`, `ProbeHandler<K>`, `ProbeOptions<K>`, `Unsubscribe`, `VetoableEventKind`, `VetoDecision`, `VetoHandler<K>`, `VetoOutcome`, `DoctorStatus`, `DoctorCategory`, `DoctorCheck`, `DoctorCheckContext`, `DoctorCheckResult`, `DoctorCheckRecord`, `DoctorReport`, `ProviderCallId`, `ProviderCallUsage`, `SandboxDecisionAction`, plus first-time exposure of all `AgentBusEvent` shape types.

  Doctor types ship in this release; the runtime registry + CLI command land in a subsequent ses_007 patch.

## 0.4.3

### Patch Changes

- ddd0aad: Test-side hardening from ses_006 pre-freeze fix.

  - **New test: `runtime/query/iteration/phases/advisory.test.ts`** — pins the advisory-phase mutation boundary where fired advisories inject user messages via `runMgr.pushMessage(createUserMessage(...))`. 13 assertions covering early-return paths, happy-path exactly-once calls, envelope format, warnings + decisions rendering, and trigger-selection semantics. Before this test a regression removing the `pushMessage` call at `advisory.ts:154` would pass typecheck, lint, the coverage gate, and every existing `src/advisory/*` test. It now fails deterministically.
  - **`LogLevel` gains `'silent'`** — purely additive; the value short-circuits every `log()` call. Used by the SDK's vitest setup to suppress unmocked `getRootLogger()` stderr writes so GitHub Actions stops annotating `[ERROR]`-level log lines as workflow errors. Consumer impact: zero unless you pass `'silent'` to `configureLogger()` yourself.
  - No runtime behavior change. No public surface additions beyond the one `LogLevel` union member.

## 0.4.2

### Patch Changes

- 14ff062: Public-surface barrel split (ses_011-sdk-public-surface).

  **Note on bump level.** Originally classified as minor when ses_011 froze on 2026-04-21. Downgraded to patch post-freeze (2026-04-21) as part of a repo-wide release-cadence policy decision: the pre-1.0 SDK reserves minor/major for feature-delta releases, and internal refactors that keep the public-surface baseline intact ride patch. This changeset explicitly preserved all 380 pre-existing public names (verified by `.github/scripts/verify-public-surface.mjs`), so patch is semver-accurate at the name-set level. See `.changeset/sdk-replay-primitive.md` for the same-day rationale block.

  `packages/sdk/src/index.ts` splits from 357 lines of mixed re-exports into three focused bucket files, consumed through a thin 10-line root barrel:

  - **`public-types.ts`** — every type a consumer type-checks against (branded IDs, wire shapes, domain entities, store contracts, event unions, config types).
  - **`public-runtime.ts`** — every runtime value (classes, functions, constants, zod schemas, error classes, ID generators).
  - **`public-tools.ts`** — agent-tool surface (`defineTool` primitive, built-in tools, domain builders, connector tool bridge, `createRAGTool`).

  No consumer-visible change. All 380 previously-exported names continue to be exported; none removed, none added. Verified by a baseline snapshot (`.github/scripts/public-surface-baseline.json` — captured at the tip of ses_010) plus a CI smoke test (`.github/scripts/verify-public-surface.mjs`) that loads `@namzu/sdk` at runtime and compares `Object.keys()` against the baseline.

  Additional cleanup:

  - The `ProjectId` / `RunId` / `MessageId` / `SessionId` double-channel (reachable through both `contracts/` and `types/ids/`) is closed. IDs come from `types/ids/` uniformly; `contracts/ids.ts` is deleted; `contracts/api.ts` imports IDs from `../types/ids/` directly.
  - The `RunStatus` carve-out is folded. Since ses_010 renamed the wire-side alias to `WireRunStatus`, the domain `RunStatus` can flow through `types/run/index.ts` with a plain `export *` — no explicit carve-out needed.

- 2eccadd: Replay primitive v1 — fork an existing run from any stored checkpoint with optional mutation at the fork point (ses_005-deterministic-replay).

  **Note on bump level.** This release adds new public exports (`prepareReplayState`, `listCheckpoints`, `projectEmergencyToCheckpoint`, `MutationNotApplicableError`, the `Mutation` / `CheckpointListEntry` / `ReplayAttribution` types, `Run.replayOf?`). In strict semver these would be a minor bump. Classified as patch here because the SDK is pre-1.0 and the project reserves minor/major for larger feature deltas — 0.5.0 should land with a more complete replay surface (5b end-to-end wrapper, reproduce mode, or similar) rather than just this state-preparation half. Decision logged 2026-04-21 post-freeze of ses_005.

  New public runtime values:

  - **`prepareReplayState({ baseDir, runId, fromCheckpoint, mutate?, emergencyDir? })`** — pure-read helper that resolves `fromCheckpoint` (`CheckpointId | 'latest' | 'emergency'`), applies mutations, and returns `{ messages, sourceCheckpoint, attribution }` ready to thread into a `query(...)` call.
  - **`listCheckpoints({ baseDir, runId })`** — lists a run's checkpoints as lightweight `CheckpointListEntry` projections.
  - **`projectEmergencyToCheckpoint(dump)`** — project an `EmergencySaveData` snapshot to an `IterationCheckpoint` shape with deterministic `cp_emergency_*` id.
  - **`MutationNotApplicableError`** — thrown by `prepareReplayState` when a mutation targets a tool call that is not pending at the fork point; carries `availableToolCallIds` for recovery.

  New public types:

  - **`Mutation`** — discriminated union; single `injectToolResponse` variant in v1.
  - **`CheckpointListEntry`** — listing projection distinct from the pre-existing HITL `CheckpointSummary`.
  - **`ReplayAttribution`** — `{ sourceRunId, fromCheckpointId, mutations, replayedAt }` record.
  - **`Run.replayOf?: ReplayAttribution`** — optional attribution field; `undefined` on original runs.

  Scope and non-scope — v1 ships **forked execution from a captured checkpoint, not byte-for-byte reproduction**. Past the fork point, provider calls and tool calls execute live. Deterministic reproduce mode is deferred to a follow-up session.

  A single-call `replay({ runId, opts })` wrapper is intentionally not shipped in v1. Composing `listCheckpoints → prepareReplayState → caller-owned query()` is the v1 flow; the wrapper requires a `ReplayEnvironment` design (provider, tools, resume handler, session scope) that lands in a follow-up session.

  See `docs/sdk/runtime/replay.md` for the full primitive docs, determinism envelope, and non-scope.

- 9efae03: Type layering rationalised (ses_010-sdk-type-layering).

  **Note on bump level.** Originally classified as minor when ses_010 froze on 2026-04-21. Downgraded to patch post-freeze (2026-04-21) as part of a repo-wide release-cadence policy decision: the pre-1.0 SDK reserves minor/major for feature-delta releases, and internal refactors that keep the public-surface baseline intact ride patch. This changeset introduced no consumer-visible new names and renamed `AgentRun → Run` with a `@deprecated` alias, which the policy treats as a patch-level churn for 0.x. See `.changeset/sdk-replay-primitive.md` for the same-day rationale block.

  All pure shapes — entities, store contracts, wire types, events — now live under `packages/sdk/src/types/`. Feature folders (`session/`, `manager/`, `store/`, `agent/`, `provider/`) contain runtime code only.

  **Public surface changes:**

  - `AgentRun` renamed to `Run`. `AgentRun` and `AgentSession` are kept as `@deprecated` type aliases for the 0.4.x compatibility window — existing code importing either continues to compile. New code should use `Run`.
  - Wire-side `Run` interface renamed to `WireRun`, mirroring the existing `WireRunStatus` precedent. The root `@namzu/sdk` barrel now exports domain `Run` and wire `WireRun` with no collision.
  - Internal folder `packages/sdk/src/session/hierarchy/` removed. Only the `@namzu/sdk` root barrel (`.`) is a supported import surface; deep-imports were never supported and the old path no longer exists.

  No runtime behaviour change. Every entity previously exported (`Project`, `Thread`, `Session`, `SubSession`, `ActorRef`, `Lineage`, `Tenant`) continues to be exported from `@namzu/sdk`.

## Unreleased

### Minor Changes

- ses_010-sdk-type-layering: Type layering rationalised. All pure shapes (entities, store contracts, wire types, events) now live under `packages/sdk/src/types/`; feature folders under `session/`, `manager/`, `store/`, `agent/`, `provider/` contain runtime code only.

  Public surface changes:

  - `AgentRun` renamed to `Run`. `AgentRun` and `AgentSession` remain as `@deprecated` type aliases for the 0.4.x compatibility window; consumers importing either keep compiling. New code should use `Run`.
  - The wire-side `Run` interface at `contracts/api.ts` renamed to `WireRun` — mirrors the existing `WireRunStatus` precedent. The root `@namzu/sdk` barrel now exports domain `Run` (from `types/run/`) and wire `WireRun` (from `contracts/`) with no same-symbol collision.
  - Internal folder `packages/sdk/src/session/hierarchy/` removed. Only the `@namzu/sdk` root barrel (`.`) is a supported import surface; deep-imports were never supported and the path no longer exists.

  No change to runtime behaviour. Every entity shape that used to live under `session/hierarchy/` (`Project`, `Thread`, `Session`, `SubSession`, `ActorRef`, `Lineage`, `Tenant`) continues to be exported from `@namzu/sdk` — only the internal folder structure moved.

## 0.4.1

### Patch Changes

- c9b180d: Coordinated patch bump across all publishable packages after the `@namzu/telemetry@0.1.0` extraction landed. No functional changes — this is a compatibility and release-pipeline validation cut to (a) exercise the Trusted Publisher binding for `@namzu/telemetry` that was configured after the 0.1.0 bootstrap publish, and (b) give consumers a single aligned set of patch versions that all know about the new telemetry package.

  Resulting versions:

  - `@namzu/sdk` → `0.4.1`
  - `@namzu/telemetry` → `0.1.1`
  - `@namzu/computer-use` → `0.2.1`
  - `@namzu/anthropic`, `@namzu/bedrock`, `@namzu/http`, `@namzu/lmstudio`, `@namzu/ollama`, `@namzu/openai`, `@namzu/openrouter` → `0.1.2`

## 0.4.0

### Minor Changes

- 96e3f84: **BREAKING**: OpenTelemetry SDK and exporters extracted to `@namzu/telemetry`. `zod` and `zod-to-json-schema` moved to `peerDependencies`. `@opentelemetry/api` moved to `peerDependencies`.

  All removed exports have a replacement in `@namzu/telemetry`:

  | Removed                                    | Import from `@namzu/telemetry`             |
  | ------------------------------------------ | ------------------------------------------ |
  | `TelemetryProvider`                        | `TelemetryProvider`                        |
  | `initTelemetry` (sync)                     | `registerTelemetry` (async — **await it**) |
  | `getTelemetry`, `getTracer`, `getMeter`    | same names                                 |
  | `createPlatformMetrics`, `PlatformMetrics` | same names                                 |
  | `TelemetryConfig`, `ExporterType`          | same names                                 |
  | `GENAI`, `NAMZU`, span-name helpers        | `@namzu/telemetry/attributes` subpath      |

  Install-surface delta: `@namzu/sdk` runtime deps 10 → 0. Consumers who don't emit telemetry and don't use Zod directly install 0 extra packages from the SDK tree. See [`docs/migration/0.4.md`](https://github.com/cogitave/namzu/blob/main/docs/migration/0.4.md) for the full upgrade path.

  Related: `@namzu/telemetry@0.1.0` initial publish ships in the same release.

## 0.3.0

### Minor Changes

- 40eb841: Unblock BYO-provider use of `AgentManager.spawn` and capture the full 0.2.x → 0.3.0 window.

  **Bug Fixes**

  - `AgentManager.sendMessage` no longer requires both `configBuilder` AND `factoryOptions` together. The configBuilder now runs whenever it is registered; `factoryOptions` defaults to `{}` when absent. This closes the silent crash path that consumers following README's "getting started" install hit with Bedrock (ERESOLVE → bare-config → ReactiveAgent null access).
  - `AgentFactoryOptions.apiKey` is now optional. BYO-provider flows (Bedrock IAM, custom `ProviderRegistry.create(...)`) no longer need to fabricate a meaningless empty `apiKey` just to satisfy the type.

  **Breaking Changes carried over from the 0.2.x → 0.3.0 window**

  - `feat(sdk)!: propagate threadId through runtime + wire archive gate` — childConfig now receives `sessionId/threadId/projectId/tenantId` automatically from the parent context (stamped by AgentManager after configBuilder returns). configBuilder implementations that previously emitted these fields manually are unaffected; implementations relying on the old 0.2.0 three-ID triple (`sessionId/projectId/tenantId` without `threadId`) will now see `threadId` populated on the child config.

  **Other**

  - `knip` integrated as the dead-code detector (dev-only, no runtime surface change).
  - `ThreadManager.archive`/`delete` primitives added to `SessionStore`; wire-side `thread_id` renamed during the Thread→Project wire refactor (internal rename).

  See commits since `sdk-v0.2.0` for the full list; this changeset captures the visible-to-consumer summary.

All notable changes to Namzu are documented here.

## [0.2.0] — 2026-04-17

### Features

- **sdk**: close Task 10 known deltas + expose session hierarchy (Phase 9) [**BREAKING**]
- **sdk**: add retention + archival primitives with deleteSession close-out (Phase 8)
- **sdk**: add migration utilities for 0.2.0 upgrade path (Phase 7)
- **sdk**: refactor AgentManager to spawn SubSession triple with kernel summarization (Phase 6) [**BREAKING**]
- **sdk**: add SessionSummaryMaterializer kernel terminalization primitive (Phase 5)
- **sdk**: add handoff state machine with atomic broadcast rollback (Phase 4)
- **sdk**: add SessionStore + PathBuilder + git-worktree workspace driver (Phase 3) [**BREAKING**]
- **sdk**: add RunEvent schemaVersion + sub-session lifecycle events (Phase 2) [**BREAKING**]
- **sdk**: introduce session hierarchy type foundation (Phase 1) [**BREAKING**]

### Testing

- **sdk**: add Task 10 integration test coverage matrix (Phase 10)

## [0.1.8] — 2026-04-15

### Documentation

- **changelog**: update for sdk-v0.1.7
- **readme**: rewrite root + fix sdk stale ProviderFactory refs

## [0.1.7] — 2026-04-15

### Documentation

- **changelog**: add 0.1.6 (sdk) and 0.1.0 (computer-use) entries; fix cliff tag prefix + workflow race
- **changelog**: update for sdk-v0.1.6-rc.1

### Features

- **bedrock**: extract BedrockProvider to @namzu/bedrock package (Phase I.3 pilot)
- **openrouter**: extract OpenRouterProvider to @namzu/openrouter package (Phase I.4)

### Refactor

- **sdk**: address Codex review — scope providers/ subfolder, hide registry reset
- **sdk**: replace ProviderFactory with ProviderRegistry for per-vendor extraction [**BREAKING**]

## [0.1.6-rc.1] — 2026-04-15

### Documentation

- **changelog**: update for v0.1.5

### Features

- **sdk**: add ComputerUseHost interface and computer_use tool

### Miscellaneous

- initialize namzu monorepo from sdk; add @namzu/computer-use capability package

## [0.1.5] — 2026-04-15

### Bug Fixes

- **emergency**: uuid tmp suffix, outer try/catch, and explicit exit
- **store**: resolve withLock race, delete deadlock, and atomic edge updates

### Documentation

- **changelog**: update for v0.1.5-rc.2

### Refactor

- **barrels**: route root barrel through sub-barrels (Path B)
- **connector**: brand ConnectorId/TenantId on public interfaces [**BREAKING**]

### Testing

- **store**: add concurrency regression tests for DiskTaskStore

## [0.1.5-rc.2] — 2026-04-14

### Bug Fixes

- **plugin**: wire MCP servers and fail fast on unsupported contributions
- **plugin**: consume hook results and wire tool hooks in runtime
- **release**: normalize pre-release counter to strip non-digit suffix

### Documentation

- **changelog**: update for v0.1.5-rc.1-fix
- **contracts**: formalize wire/domain duality + refresh README
- **readme**: rewrite code examples to match current SDK API

### Refactor

- **plugin**: remove duplicate PluginConfigSchema in types/
- **registry**: migrate Agent/Connector/Tool registries to ManagedRegistry
- **run**: remove legacy Session\* aliases for run-centric classes

## [0.1.5-rc.1] — 2026-04-12

### Documentation

- **changelog**: update for v0.1.4

### Refactor

- architectural cleanup and infrastructure improvements

## [0.1.4] — 2026-04-11

### Documentation

- **changelog**: update for v0.1.4-rc.3

### Features

- sandbox isolation, new tools (edit/grep/ls), session-to-run migration

## [0.1.4-rc.3] — 2026-04-10

### Miscellaneous

- **release**: derive version from git tag, no manual bump needed

## [0.1.4-rc.2] — 2026-04-10

### Bug Fixes

- **ci**: remove duplicate --strip flag in git-cliff command
- **plugin**: rename session hooks to run_start/run_end
- **release**: use tag name as release title instead of prefixed name

### Features

- P3 + plugin architecture — emergency save, memory index, plugin system
- P2 — AgentBus, prompt cache split, verification gate
- integrate compaction loop and advisory phase into iteration pipeline

### Miscellaneous

- **changelog**: automate CHANGELOG.md via git-cliff in release workflow

## [0.1.4-rc.1] — 2026-04-10

### Bug Fixes

- add description field to package.json, reorder README badges

### Features

- **advisory**: provider-agnostic advisory system with three-layer architecture
- structured compaction, tool tiering, task router
- output discipline, shell compression, pre-release workflow

### Miscellaneous

- remove BEFORE-RELEASE.md from repo

## [0.1.3] — 2026-04-10

### Bug Fixes

- point entry fields to dist/ for bundler compatibility

### Documentation

- add npm, ci, license, typescript, node badges to README

## [0.1.2] — 2026-04-10

### Other

- Namzu v0.1.1 — Wisdom, shared

Open-source AI agent framework by cogitave.

Let's build the agent layer together.

### Refactor

- constants centralization, strict lint, release automation
