---
'@namzu/sdk': major
---

Run events carry a sequence, and the log can be read back

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
