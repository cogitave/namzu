---
type: Design
title: Resident agents experiment
description: Staged plan and first opt-in SDK experiment for durable pursuits, internal continuation and honest interruption handling.
resource: packages/sdk/src/manager/resident
tags: [sdk, agents, continuity, research]
status: draft
---

# Resident agents experiment

## Objective and boundary

An agent should be able to retain its identity and an authorized pursuit across
conversation boundaries, take another useful step without another user message,
and wait without spending model calls when there is no useful work.

This is an experimental, opt-in SDK surface. No CLI defaults change. It does not
claim consciousness, independent desires, autonomous goal discovery or a daemon
that survives application shutdown. `@experimental` identifies maturity, not an
exemption from the package's versioning policy.

## Source comparison

- [Background scheduling implementation](https://github.com/NousResearch/hermes-agent/blob/8c74118c4a0c332a6bc57d2509147bad0e6ee864/cron/scheduler.py)
  uses a locked tick, worker ownership and result delivery. Its durable memory
  and reusable skills motivate continuity across separate runs; they are not
  evidence of spontaneous consciousness.
- [Heartbeat contract](https://github.com/openclaw/openclaw/blob/227e7ae26af4e4f3f8a256c4fa808c7b046f4c88/docs/gateway/heartbeat.md)
  separates silent outcomes from notifications and defers busy agents. At this
  revision recurring proactive work is configured explicitly, not inferred from
  old chats by default.
- Namzu already has session goals, revision stores, provider-independent runs,
  persona assembly and memory. `SessionGoalActivation` deliberately grants only
  process-local automatic continuation. The experiment is separate from that
  contract and reuses the existing immutable revision store.

## Delivery plan and acceptance criteria

| Stage | Deliverable | Acceptance evidence |
| --- | --- | --- |
| 1 — initial experiment | Durable identity and one pursuit; developer-owned step; scheduled continuation or indefinite rest | Reopen state between steps; no call before due time or after completion; concurrent owners admit once; uncertain work is not replayed |
| 2 — resident host | Multiple pursuits, cancellation routing, explicit restart authorization and process reconciliation | Kill/restart while idle and during tools; no false completion or repeated unconfirmed effects; foreground operator work can preempt background work |
| 3 — initiative | Propose subgoals within host-approved domains; select using evidence, progress and measured cost | Compare against fixed heartbeat and no-initiative controls; measure useful completed work, redundant work, idle model calls and spend |
| 4 — communication | Durable outbox, delivery acknowledgments, deduplication and quiet hours | Disconnect/reconnect destination; replay pending delivery without confusing generated text with delivered text |
| 5 — learning | Versioned identity/preferences and evaluated reusable skills | Contradict stale beliefs with evidence; evaluate a proposed skill before promotion and roll it back when it regresses |

Stage 1 implements only the first row. Stages 2–5 remain proposed work. No
outbound messaging or external account access is enabled by this experiment.

## Stage 1 SDK contract

`DiskResidentStore(root, { tenantId, agentKey })` owns one tenant/registry-key
record. `create(identity, objective)` initializes one pursuit. Keys use an
injective filesystem encoding; IDs are not inferred from directory names.
Callers supply a trusted, host-owned root. This is logical scope isolation, not
an OS sandbox against a process that can mutate that directory or its symlinks.

`ResidentStore` is the storage contract. Alternative backends must atomically
compare revisions and persist claim admission before allowing work. Disk storage
uses immutable hard-linked revisions; unsupported filesystems fail explicitly.
Revision history is not compacted in this first experiment. It does not promise
power-loss durability or exactly-once external effects.

`stepResident(store, step, signal)` first reads durable state. It invokes no
callback for a completed, blocked, not-due or already-running record. A due step
gets an exclusive revision and claim UUID before the developer callback runs.
The callback receives the identity, objective, prior summary, admission count
and wake reason, then returns one `ResidentDecision`:

- `wait`, `wakeAt: <future epoch milliseconds>`: continue internally later.
- `wait`, `wakeAt: null`: rest until the host supplies new evidence with `wake`.
- `complete`: pursuit is finished; it cannot be woken again.
- `blocked`: a prerequisite is missing; this prototype does not auto-unblock it.

Each decision carries a nonempty summary, limited to 8,000 characters. Only the
last summary is projected into the next callback. Full episodic memory, tool
transcripts, multiple pursuits and arbitrary persistent scratch state are not
implemented here. Identity and objective remain immutable for this pursuit.

`runResident({ store, step, signal, maxSteps, maxIdleMs })` drives internal
continuation without another user prompt. `maxSteps` is required and finite;
`maxIdleMs` defaults to 60 seconds and bounds each idle wait. Longer waits return
control to the host. These are invocation limits, not a lifetime budget or token
ledger. The host binds normal SDK provider, tool and token policies in `step`.
There is no polling model call: a waiting state is checked locally.

The driver does not watch external store changes while sleeping. Operator
preemption should abort the invocation; a future resident host will own wake
delivery. An abort interrupts idle sleep, but cannot forcibly stop a callback
that ignores its signal or undo its external effects.

## Crash and recovery

A failed, aborted or interrupted step retains its running claim. Another reader
reports `idle / unresolved`; this does not assert whether the original process
is alive. Claims have no automatic expiry or takeover. A host must stop the old
executor and inspect its effects before explicitly `settle`-ing the exact saved
claim. Settlement advances the revision, fencing late state commits. It does not
fence already-running external tools; recovery must not be performed concurrently
with them. This conservative first experiment prevents blind replay rather than
pretending to have implemented a distributed execution service.

## Reproducible experiment

After building the SDK and selected driver:

```bash
node research/resident/run.mjs
node research/resident/run.mjs --live
```

The default uses the real SDK loop with a scripted mock provider. `--live` uses
the free public model from the bundled Zen driver with low effort, no tools and
a finite run budget. The script creates only its own temporary directory and
prints its location, actual run outcomes and idle-call count. One initial
objective is provided; there is no second user message between steps. It reopens
the store between the first step and automatic continuation. This is a small
continuity experiment, not an intelligence benchmark or proof of spontaneous
initiative. A provider failure is reported and does not count as completion.

### First live observation (2026-09-11)

The live experiment passed with two low-effort provider calls, both ending with
`end_turn`: a draft, then a revised checklist using the saved summary. The final
state was `complete` with two admissions. The subsequent idle check made zero
model calls. The store was reopened between model calls in the same host
process. A separate two-process test proved exclusive admission and persistence
of the claim after its owner exited. These are different tests; no live model
process-crash recovery claim is made.

The retained synthetic evidence is
`research/resident/results/2026-09-11.json`. No tokens or cost were measured in
this smoke experiment. Both the initial prompt and callback explicitly request
a two-stage task, so this does not establish independent goal selection.
