---
title: Durable Pause
description: A run that stops for a human survives the process it stopped in. Pending decisions, the resume token, the run lease, resume vs fork, and what a pause cannot carry across.
last_updated: 2026-07-13
status: current
related_packages: ["@namzu/sdk", "@namzu/api"]
---

# Durable Pause

A run reaches a tool review. There is nobody in the process to answer it, and the human who will answer it is asleep. In `0.4.x` that run had two futures, and both were wrong: it blocked a live process on a promise nobody would resolve, or it was quietly marked **completed** and its unexecuted tool calls were repaired out of the history on the way back in.

A durable pause is the third future. Reaching a review **parks** the run and returns. The generator ends, the process is free, the machine can be redeployed. Answering the decision records the outcome and resumes from the checkpoint — in a different process, on a different day, with the tool call the human approved still sitting there unexecuted, exactly as it was.

This page is the contract for that: how a run parks, how it is answered, who is allowed to drive it, what a resume costs, and — in [Section 8](#8-what-a-durable-pause-cannot-do) — the things it genuinely cannot do. Read that section. It is not a disclaimer, it is part of the design.

## 1. Two Models, and Which One You Get

There are two ways a HITL request gets answered, and they coexist. Which one you get is decided by one thing: **whether an in-process handler answers**.

| Entry point | No `resumeHandler` passed | What happens on a tool review |
| --- | --- | --- |
| `query()` | Falls back to `deferredReviewHandler` | The run **parks durably**. The question is persisted; the generator returns |
| `drainQuery()` | Falls back to `autoApproveHandler` | The batch is **approved and executed**, as it always was |

**The in-process handler is the fast path, and it is unchanged.** An embedder that passes a `resumeHandler` and answers synchronously gets exactly the behavior it had before: the review `await`s the handler inside the iteration, the answer is applied in place, the run continues. Nothing on this page changes that.

```ts
// Fast path — a synchronous reviewer. Unchanged.
await drainQuery({
  resumeHandler: async (request) => {
    if (request.type === 'tool_review') return await askTheOperatorRightNow(request)
    return { action: 'continue' }
  },
  // ...provider, tools, runConfig, scope
})
```

**Durable pause is what happens when nobody answers.** Call `query()` with no handler and `deferredReviewHandler` takes over, which answers each request type according to what that request actually authorizes:

| Request | Answer with no in-process reviewer | Why |
| --- | --- | --- |
| `tool_review` | `pause` — the run parks durably | It authorizes tool execution. With nobody to ask, nothing runs |
| `plan_approval` | `reject_plan` — the run ends | It authorizes a plan, so it is refused. It is **not** parked: the checkpoint captures no `PlanManager`, so a parked plan approval would have nothing to resume into |
| `iteration_checkpoint` | `continue` | It authorizes nothing. It is an observation point, and parking on it would stall every handler-less run at every iteration boundary |

Note the asymmetry in the table above: `drainQuery()` still defaults to auto-approve. That is deliberate and conservative. `drainQuery` has always substituted auto-approve for a missing handler, and flipping it to park would silently convert every existing caller's run from "approve and finish" into "wait forever for a decision nobody is coming to make". **To get a durable pause out of `drainQuery`, ask for one:**

```ts
import { drainQuery, deferredReviewHandler } from '@namzu/sdk'

const run = await drainQuery({ resumeHandler: deferredReviewHandler, /* ... */ })
// run.status === 'awaiting_input' if it parked
```

And a handler that is present can hand any single decision out-of-process at any time by answering `{ action: 'pause', reason }`. That is what `pause` has always meant. It now survives.

## 2. What Parking Actually Does

When a tool review is answered with `pause`, in this order:

1. **The question is persisted** onto the checkpoint the review was raised at, as a `PendingDecision` — the request verbatim, its state, and an opaque resume token.
2. **The run is marked `awaiting_input` on disk**, with a pointer to the checkpoint and request it is parked on. On disk, not just in memory: a process killed before the generator returns leaves a run that can still be answered, rather than one stuck at `idle` holding a live decision.
3. **`run_paused` is emitted**, carrying `runId`, `checkpointId` and the reason.
4. **The lease is released** ([Section 5](#5-the-run-lease-who-is-driving-this-run)), so the parked run is resumable at once rather than one TTL later.
5. **The generator returns.** The run comes back `awaiting_input`.

A suspended run gets none of the end-of-run treatment: no `run_end` plugin hooks (they would fire again on resume, and a plugin that tears down on `run_end` would tear down a live run), no `run_completed`, no `endedAt`, no result. It is not finished. It has more to do the moment a decision arrives.

The reviewed tool calls stay in the history **unanswered**, on purpose. That pending batch is what a resume acts on. It is also why `pendingDecision` has to exist at all: without it, `prepareResumeMessages` cannot tell a pause from a crash, and it repairs the unexecuted call into a `[SYSTEM] Tool result missing` placeholder. The repair is right for a crash and catastrophic for a pause, and the two are indistinguishable in the record precisely *because* the decision was not persisted. It is now, so the repair is suppressed for exactly as long as a decision owns that block.

### `tool_review_completed` is not emitted on a pause

A pause has no outcome; the question is still open. Before `0.5.0` the pause path emitted `tool_review_completed { decision: 'rejected' }` on its way out, so a client that closed its approval dialog on that event told its user the tools had been **denied** while the batch sat on disk waiting to be approved. **The pause is announced by `run_paused`.** The review completes exactly once, when it is actually decided.

## 3. The Pending Decision State Machine

A decision is persisted on the checkpoint and moves through five states:

| State | Means | What a resume does with it |
| --- | --- | --- |
| `pending` | Put to a reviewer, unanswered. The tool-call block is untouched | Re-emits the request (same `requestId`) and parks again |
| `resolved` | An outcome was recorded — the token was redeemed. **Nothing has run** | Applies the outcome to that exact tool-call block, then finishes the interrupted iteration |
| `executing` | The batch was dispatched. **Some calls may already have had their real-world effect** | Consults the journal. Never re-executes. See [Section 8.1](#81-the-lease-stops-a-write-not-a-side-effect) |
| `settled` | Every call has a result in the history. The decision no longer owns the block | Nothing. The block is answered |
| `cancelled` | The run was cancelled while the decision was open | Nothing. It can never be answered |

Persisting only the *request* would not be enough, and the extra states are not bookkeeping. Without them the record cannot distinguish **"never answered"** from **"approved, then the process died halfway through the batch"** — and that ambiguity is precisely how a durable pause re-runs a destructive tool.

The `requestId` is **stable across every re-emission**. A run that parks, is resumed, and finds its decision still `pending` re-emits the same event with the same id, so an idempotent client is not asked the same question twice under two names.

## 4. The Resume Token

`ResumeToken` (`rt_...`) is an opaque, single-use capability that identifies one paused decision and permits it to be answered. It is scoped to (run, request), and redeeming it invalidates it.

**It is not on the event stream.** An event stream is a broadcast, and a capability broadcast to every subscriber is not a capability. The token lives on the checkpoint and is handed out by an authorized server-side read:

```ts
import { readPendingDecision } from '@namzu/sdk'

// Server-side. Authorize the caller FIRST, then read.
const decision = await readPendingDecision({
  baseDir: '/path/to/.namzu/runs',
  runId,
  parentRunId,        // required when the run is a CHILD run
  checkpointId,
})
decision?.resumeToken   // 'rt_…'
```

**Possessing the token is necessary but NOT sufficient.** A leaked resume token must not *be* an authorization: the route that accepts a decision still has to establish that the caller owns the run. n8n's Ni8mare (CVE-2026-21858) is the in-the-wild proof that the endpoint resuming a paused execution is a real attack surface, and it is exactly this threat class. The SDK gives you the capability check. **The authorizing route above it is yours to build, and there is no default that is safe without one.**

### Answering a decision

`resumeDecision` is the **state-preparation** half. It validates, records the outcome, and hands back the state a resume needs. It deliberately does not execute anything: `query()` needs a provider, a tool registry, session scope and a sandbox, none of which can be reconstituted from a durable record — so the caller owns them and the caller supplies them. This is also how BYOK survives a pause: **credentials are re-supplied on the decision call exactly as they are on run creation.** Namzu never becomes the custodian of your provider key.

```ts
import { resumeDecision, drainQuery } from '@namzu/sdk'

const prepared = await resumeDecision({
  baseDir, runId, checkpointId,
  resumeToken,                          // the capability
  decision: { action: 'approve_tools' },// what the human answered
})

await drainQuery({
  resumeFromCheckpoint: prepared.checkpointId,  // the dispatcher picks the decision up here
  runId: prepared.runId,                        // same logical run, same ledger
  messages: [],                                 // IGNORED on the resume branch — history comes from the checkpoint
  provider, tools, runConfig,                   // caller-owned runtime, credentials re-supplied
  agentId, agentName, sessionId, threadId, projectId, tenantId,
  workingDirectory,
})
```

The checks `resumeDecision` runs, in order, because the order is the design:

| # | Check | Failure |
| --- | --- | --- |
| 1 | Is the run still parked? Asked of the run's own persisted status | `RunNotResumableError` — only an `awaiting_input` run may be answered |
| 2 | Is anyone still driving it? | `RunLeaseHeldError`. A **stale** lease does not refuse — that is a crashed holder, and taking its run over is the recovery |
| 3 | Is there a decision to answer? | `DecisionNotFoundError` |
| 4 | Has it already been answered? | `DecisionAlreadyResolvedError`, **carrying the recorded outcome** |
| 5 | Is the token right? Constant-time compare | `DecisionTokenInvalidError` — raised identically for a malformed, stale or foreign token |
| 6 | Does the outcome answer the question that was asked? | `DecisionOutcomeInvalidError` |
| 7 | **Claim it.** A durable compare-and-set (an exclusive file create the filesystem arbitrates) | Loser gets `DecisionAlreadyResolvedError` |

Steps 1 through 6 are *screening* and spend nothing. Step 7 is the *arbitration*, and it is what makes the token single-use. **Exactly one caller can ever leave `resumeDecision` with a prepared resume** — including one presenting the identical outcome. A loser is refused with the recorded outcome riding on the error, so your route can tell an exact duplicate (answer `200` with it) from a conflicting one (`409`) without a second round trip. "Idempotent" has to mean *the tools run once*, not that both callers are told yes.

Each error exists because your route has to answer a different HTTP status for it. That is why they are six classes and not one `Error` with six messages.

## 5. The Run Lease: Who Is Driving This Run

A **segment** is one pass through `query()`: the original run, or any later resume. The run is the durable thing; segments come and go. The lease is what says which one owns it.

Without it, two processes could drive `query({ resumeFromCheckpoint })` for the same run at the same time, both write `run.json` and `messages.json`, and the last writer would win — silently discarding the other's work, including tools it had already run.

**Every segment takes the lease. A segment that cannot take it does not run.** `QueryParams.lease` tunes it; it does not switch it off.

| Property | Value |
| --- | --- |
| TTL | `DEFAULT_RUN_LEASE_TTL_MS` — 30s without a renewal and the lease is stale |
| Heartbeat | `DEFAULT_RUN_LEASE_HEARTBEAT_MS` — 10s (TTL/3), so two renewals can be lost before it goes stale |
| Release | On **every** exit — park, finish, fail. A released lease is free immediately |
| Fencing token | A strictly increasing integer, one per acquisition. It is the lease file's own name (`leases/000001.json`) |

### The three states, and they are three

`readRunLease` is the operator-facing read. Reporting two states where there are three is how a crashed run gets described as a run waiting for a human:

| State | Means | What it means to an operator |
| --- | --- | --- |
| `free` | Nobody is driving it | With `run.json` reading `awaiting_input`, the run is **parked**. Safe to resume right now |
| `held` | A live segment has renewed within its TTL | Not parked, whatever the run's last persisted status says. A segment mid-iteration has not written anything since it started |
| `stale` | A holder took the lease and stopped renewing | Presumed **dead**, and `expiresAt` says since when. The run can be taken over. It must not be *reported* as parked: nobody is waiting on a human here, something died |

```ts
import { readRunLease } from '@namzu/sdk'

const view = await readRunLease({ baseDir, runId })
view.status     // 'free' | 'held' | 'stale'
view.token      // highest fencing token ever issued for this run
view.expiresAt  // when a held lease goes stale, or when a stale one did
```

### Why the fence exists

Expiry is a **guess**. A holder that stopped renewing may be dead, or may be a live process that was paused for 31 seconds and is about to wake up and finish writing. Without a fence, that process wakes into a run that has moved on without it and clobbers it: its `run.json` write resurrects a run that has since completed, its `messages.json` write replaces the new history with the old one.

With one, its write is refused (`RunLeaseLostError`): the run is now on a higher token, and a writer whose token is not the current one may not write at all. **The TTL decides when we act; the token makes it safe to be wrong.**

The fence guards the **execution plane** — `run.json`, `messages.json`, checkpoints, the report, the index — and not the control plane. A store with no lease (a cancel, a redemption, an operator read) writes freely, because a cancel that could not touch a run somebody is driving would be useless, and the control plane's own races are arbitrated by the decision claim instead. `transcript.jsonl` is deliberately unfenced too: it is append-only, so a superseded segment's events are evidence, not corruption.

A segment that loses its lease mid-run is aborted, because every write it makes from that point is fenced off and the work it is doing is work nobody will accept.

## 6. Resume vs Fork

These are two different things, and until `0.5.0` they were one door with one id.

| | **Resume** | **Fork** |
| --- | --- | --- |
| Entry point | `query({ resumeFromCheckpoint })` | `prepareForkState()` |
| Run id | **The same run.** Same id, same directory, same record | **A new id.** Provenance recorded as `replayOf` |
| Ledger | The same. `tokenBudget`, `costLimitUsd`, `maxIterations` continue | **A new budget.** The fork inherits the history but not the ledger |
| Refuses | A **terminal** run — `completed`, `failed`, `cancelled` — by typed error, writing nothing | Naming the source run in `runId` (`ForkTargetsSourceRunError`) |
| Source run | Continued | Left byte-identical |

**What a resume refuses.** A terminal run, with `RunNotResumableError`. Only `cancelled` was refused before, so `query({ resumeFromCheckpoint })` would happily re-drive a *finished* run under its own id and overwrite its record. Re-driving a finished run from a checkpoint is a legitimate thing to want. It is called a fork, it gets a new id, and it has its own entry point — see [Replay](./replay.md).

**What a resume still allows, deliberately.** A non-terminal run with no decision on it: `idle`, `running`, or an `awaiting_input` run whose decision is already `settled` (a segment that applied the human's answer and then died). Those are crashed segments, and resuming them from a checkpoint is the crash recovery this entry point existed for before durable pause was built on top of it. Restricting resume to "parked with a live decision" would permanently brick every run that died mid-loop.

Note the two doors have **different admission rules**, on purpose: `resumeDecision` (answering a decision) requires `awaiting_input`, because it is spending a token against an open question. `query({ resumeFromCheckpoint })` (driving a segment) requires only non-terminal, because it also serves crash recovery.

A refusal writes **nothing**. Every admission check runs before the first write, and a refused run is left byte-identical.

## 7. Accounting Across a Resume

A resumed run continues the same logical run, and therefore the same ledger. This is what makes a pause safe to offer at all: without it, a run stopped at its cost cap could be resumed forever, each time with a full new allowance.

| Limit | Semantics across a resume |
| --- | --- |
| `tokenBudget` | **Lifetime.** Token usage accumulates across every segment |
| `costLimitUsd` | **Lifetime.** Cost accumulates across every segment |
| `maxIterations` | **Lifetime.** The iteration count is carried, not reset |
| `timeoutMs` | **Active execution time.** Only time the run spends *executing* counts |

`timeoutMs` measuring active time rather than calendar time is the load-bearing choice. An hour of human thinking is not agent compute, and charging it to a wall-clock timeout would turn every human pause into a timeout — which would defeat the feature entirely. **A pause is not a punishment for thinking: an hour parked costs the run nothing.**

The one honest caveat: time spent inside a **live** segment awaiting an in-process `resumeHandler` still burns the clock, because the segment never ended and the run is, as far as the guard is concerned, executing. Only a durable pause — the gap *between* two segments — is free. That is another reason to answer out-of-process rather than blocking a live handler for hours.

The accounting is hydrated from the checkpoint **before** `init()` writes `run.json`, because `init()` writes from in-memory state and would otherwise stamp a zeroed ledger over the real one.

## 8. What a Durable Pause Cannot Do

Everything above is what works. This is what does not, stated plainly, because a durability contract you cannot see the edges of is one you will find the edges of in production.

### 8.1. The lease stops a WRITE, not a side effect

Fencing stops a superseded segment from **writing**. It does not stop it from **running**. A stalled holder that wakes up may still be inside a tool call, and that tool's side effect has already happened by the time its write is refused. Neither the lease nor the claim can un-charge a card.

**Exactly-once execution of an arbitrary side effect is a fiction — here and everywhere else.** Every durable-execution engine surveyed for this design says so and makes idempotency the tool author's job. Namzu is **at-least-once at the batch boundary**, and it will never silently re-run:

- A per-call **execution journal** is written before dispatch and after each call settles.
- A call the journal recorded as `settled` keeps its recorded output. It ran once, we have the result, we use it.
- Everything else is **uncertain**. A journal entry that says `started` means **"may or may not have run"** — it does not mean "did not run". A crash between a tool's real-world effect and its `settled` write is irreducible (it is the Two Generals problem).
- An uncertain call is **not retried and not guessed at**. It is answered with a result that says so, surfaced on the stream as `tool_execution_uncertain`, and recorded on the decision as `uncertainToolCallIds`.

What the journal buys is not exactly-once. It is that recovery is *informed* rather than ambiguous. If your tool has a real-world effect and you need better than this, give it an idempotency key.

### 8.2. The lease is per-`.namzu`-root

The lease is arbitrated by the **filesystem** — an exclusive `wx` create, the only cross-process primitive available without a server. So it is per-root.

Two workers whose `.namzu` roots are different volumes **share no lease at all**. Nothing is corrupted (they are not driving the same files), but neither is anything coordinated. `wx` is atomic on a local filesystem and on POSIX-compliant shared mounts; it is **not** atomic on NFS without `O_EXCL` support.

**A multi-worker deployment against a genuinely shared store needs the lease moved into that store** — a Postgres advisory lock, a Redis lease, a lease row with a fencing column. The fencing-token contract is identical either way, which is why it was worth getting right here.

### 8.3. A crashed segment must burn down its TTL before anyone may resume

A segment that dies without releasing its lease leaves it `held` until it goes `stale`, which takes the full **30-second** TTL. Nobody may resume in that window.

That is the price of not being able to tell **dead** from **slow**. A lease cannot distinguish a crashed holder from one stuck in a 30-second GC pause, and guessing "dead" early is exactly how a batch runs twice. A clean pause does not pay this — it *releases* the lease on the way out, so a parked run is resumable immediately. Only a crash pays it.

### 8.4. A sandbox CANNOT survive a pause

This is a real capability gap, and it is the one most likely to surprise you.

`SandboxProvider.create()` mkdtemps a fresh root, `destroy()` removes it, and **there is no attach-by-id anywhere in the contract**. A sandbox therefore cannot outlive its process — and a durable pause is a pause that is *meant* to outlive its process.

So the sandbox is destroyed when the run parks, deliberately, with a warning that names the consequence. **The tool a human approves executes in a NEW, EMPTY sandbox.** Files written, packages installed, background processes started and every other piece of sandbox-local state built before the pause is **gone**.

Holding it open instead is not the fix: it would strand a temp tree and its processes for as long as a human takes to answer, and it would *still* not survive the redeploy the durable pause exists to survive.

What the runtime refuses to do is let it happen silently. A resumed run **tells the model**, in a `[SYSTEM]` note appended after the batch's tool results:

> This run was paused and has resumed in a NEW, EMPTY sandbox. Files, installed packages, background processes and any other sandbox-local state created before the pause were NOT carried across the pause. Tool results above that report missing files or missing setup are describing that, not a failure of your earlier work. Re-create what you need before relying on it.

A model told only `no such file: ./deploy.sh` concludes the deploy is broken and starts debugging a phantom. Told the truth, it rebuilds what it needs.

**The practical rule: a tool whose effect depends on sandbox-local state should not be parked for review.** Making this correct needs a new provider capability — a stable, re-attachable sandbox root — which is a design change to the sandbox contract, not a bug fix.

### 8.5. `PlanManager`, `WorkingStateManager` and `ActivityStore` are rebuilt empty

A checkpoint carries messages, usage, cost and guard state. It does not carry these three, and a resumed run rebuilds all of them **empty**:

| Manager | Consequence on resume |
| --- | --- |
| `PlanManager` | No plan state. This is why a `plan_approval` never parks durably — it would have nothing to resume into, so the plan gate **ends the run** instead |
| `WorkingStateManager` | The compaction working state starts empty for the new segment |
| `ActivityStore` | The activity feed shows only this segment's work |

None of them meters a budget, which is why this is acceptable rather than a correctness bug: activities are observability, not accounting. But a plugin or UI that reads them across a pause will see a gap, and should know why.

### 8.6. The API's cancel route does not yet call `cancelRun`

**This is a current limitation, and it is a security-relevant one.**

`cancelRun` is the seam a cancel must go through when the run it is cancelling may be **parked**. The SDK exposes it and uses it for the one cancel path the SDK itself owns (a suspended child run reached through `AgentManager`). **`packages/api`'s cancel route does not call it.**

The route delegates to `RunExecutor.cancel`, which signals a **live** run's abort signal — and that works, for a live run. But a parked run has no live process to signal: its generator returned when it parked. So cancelling a top-level parked run through the API today updates the API's own run record and **leaves `run.json` reading `awaiting_input` with its decision still `pending`**.

The consequence, stated without softening: **a cancelled top-level parked run remains resumable by anyone holding its resume token until that wire is connected.** The structural guarantee ("a cancelled run is never resumed") is enforced in the SDK by `resumeDecision` checking the run's persisted status — and nothing writes that status when the cancel arrives through the API's route.

If you are integrating today and you cancel parked runs, **call `cancelRun` yourself** from your cancel path:

```ts
import { cancelRun } from '@namzu/sdk'

const outcome = await cancelRun({ baseDir, runId, parentRunId })
outcome.status              // 'cancelled'
outcome.cancelledDecisions  // checkpoints whose open decision this closed
outcome.alreadyTerminal     // true when the run was already terminal and nothing changed
```

## 9. Cancellation

What a cancel reaches, and what it does not.

| A cancel... | Reaches |
| --- | --- |
| ...of a **live** run | The in-flight provider call (the run's signal is forwarded to the socket), the iteration loop, and every child run |
| ...of a **parked** run, via `cancelRun` | The persisted decision (`pending` → `cancelled`) and then the run's persisted status (`cancelled`) — in that order |
| ...of a **parked** run, via the API route today | **Not the persisted record.** See [Section 8.6](#86-the-apis-cancel-route-does-not-yet-call-cancelrun) |

`cancelRun` writes the decision **first**, and the order is what makes the window between the two writes safe rather than merely short: a redemption landing inside it finds a `cancelled` decision and is refused, rather than finding a still-`pending` one on a run that has not been marked yet.

A decision that is already `resolved` or `executing` is **left alone**. Those states mean tools may be in flight, and rewriting the record would lose the journal that says which. Cancelling the *run* still stops it; this only governs whether the decision can still be answered.

**What a cancel does not reach: a tool that is already executing.** It runs to completion. The loop stops waiting and stops issuing work; there is no rollback and none is implied.

Cancellation is **asynchronous**. The API's cancel route answers `202` when it signalled a live run — the terminal `cancelled` arrives later, on the event stream — and `200` when there was nothing to stop. Re-cancelling is a no-op, not a conflict.

## 10. Events a Client Sees

| Event | When |
| --- | --- |
| `tool_review_requested` | A review is raised. Carries `requestId` (stable across re-emissions) and `checkpointId`. **Never the token** |
| `run_paused` | The run parked. Carries `checkpointId` and the reason. **This is the pause signal** — not `tool_review_completed` |
| `run_resuming` | A segment picked the run back up from a checkpoint |
| `tool_review_completed` | The review was actually decided — `approved`, `modified` or `rejected`. Emitted **once**, and never on a pause |
| `tool_execution_uncertain` | A call was dispatched, the process died before its result was recorded, and it was **not** re-executed. Its effect is unknown |

On the wire, `awaiting_input` is a first-class run status (`WireRunStatus`) and maps to A2A's `input-required`. A client that cannot see the difference between "running" and "waiting for me" cannot know it is the one being waited on. See [Event Bridges](../integrations/event-bridges.md).

## 11. Common Mistakes

| Mistake | Consequence |
| --- | --- |
| Treating the resume token as an authorization | A leaked token answers someone else's review. The token is necessary, never sufficient — authorize the caller first |
| Putting the token on the event stream | A capability broadcast to every subscriber is not a capability. Read it server-side with `readPendingDecision` |
| Expecting `drainQuery()` with no handler to park | It auto-approves, as it always has. Pass `deferredReviewHandler` |
| Expecting sandbox state to survive a pause | It does not. The approved tool runs in a fresh, empty sandbox ([8.4](#84-a-sandbox-cannot-survive-a-pause)) |
| Re-driving a resume that "looked stuck" | The dispatch right is claimed on disk; the second drive is refused. But a crash between the claim and the journal needs an operator, because "the claim is stale" is indistinguishable from "the winner is 5ms from dispatching" |
| Answering `200` to a duplicate decision and launching a second resume | `DecisionAlreadyResolvedError` carries the recorded outcome. Answer with it; do **not** resume again |
| Cancelling a parked run through the API and assuming it is unresumable | Not yet true ([8.6](#86-the-apis-cancel-route-does-not-yet-call-cancelrun)). Call `cancelRun` |
| Reading `awaiting_input` as "parked" without checking the lease | A `held` or `stale` lease means a live or crashed segment, not a human. Three states, not two ([Section 5](#5-the-run-lease-who-is-driving-this-run)) |

## Related

- [Low-Level Runtime](./low-level.md)
- [Run Configuration](./configuration.md)
- [Reliability and Cancellation](./reliability.md)
- [Replay](./replay.md)
- [Tool Safety](../tools/safety.md)
- [Event Bridges](../integrations/event-bridges.md)
- [Migrating to 0.5.0](../../migration/0.5.md)
- [Durable Pause Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/runtime/query/decision/resume.ts)
- [Run Lease Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/types/run/lease.ts)
