---
type: Design
title: Resident initiative experiment
description: Opt-in pursuit selection, host-observed outcomes and atomic admission of bounded subgoal proposals.
resource: packages/sdk/src/manager/resident
tags: [sdk, agents, continuity, research]
status: draft
---

# Resident initiative experiment

This extends the [resident host](resident-agents.md) with measured selection and
subgoal admission. Default host fairness is unchanged. Selection is a local,
experimental heuristic: it may save work or abandon a useful task prematurely.
Neither the CLI nor an always-on service loads it automatically.

## Research and engineering choices

[Selecting Computations](https://arxiv.org/abs/1207.5879v1) treats deliberation as
a decision problem with an explicit stopping action. Its myopic value of
computation is expected improvement in the best action value minus computation
cost. It requires a probabilistic model and comparable utility/cost units. Our
progress score is not that probability model and inherits none of its optimality
results. We borrow the explicit choice to stop and the requirement to account
for computation cost.

[ALP-GMM](https://arxiv.org/abs/1910.07224v1) chooses learning environments using
absolute changes in measured reward. Its [author implementation](https://github.com/flowersteam/teachDeepRL)
operates over a parameterized environment space. A resident agent has neither
that space nor automatically comparable rewards. Our adaptation credits only
positive progress beyond the pursuit's previous best. Regression and recovering
an old best do not manufacture new progress. That prevents one form of reward
inflation, but can undervalue necessary recovery work.

[Exploration by Disagreement](https://arxiv.org/abs/1906.04161v1) distinguishes
learnable uncertainty from stochastic observations using predictor ensembles.
We do not implement its ensemble or treat language-model disagreement as a
calibrated uncertainty estimate. Its stochastic-noise problem motivates the
changing-evidence-with-zero-progress test: new bytes alone earn no benefit.

[π-Bench](https://arxiv.org/abs/2605.14678v3) evaluates proactive assistance and
task completion as separate properties across sustained interactions. Our
fixture tests likewise report completion separately from resource savings;
they are not a run of that benchmark or a general intelligence comparison.

## Observations belong to the host

`new ResidentHost(agenda, step, { select, observe })` opts into two independent
extensions, described by `ResidentHostOptions`:

- `select: ResidentSelector` is synchronous local code over an immutable agenda
  snapshot and an epoch-millisecond time. Do not place inference or external
  actions in it. It is not called while paused, unresolved or without due work.
- `observe: ResidentObserver` receives the admitted pursuit, its proposed
  `ResidentDecision`, and the cancellation signal. It verifies real artifacts
  and resource receipts, then returns a `ResidentObservation`. It must not
  simply copy a model's progress assertion.

An observation contains `evidenceKey`, `source`, `progress` in `[0,1]`, and
`costUnits` as a finite nonnegative number or `null` for unknown cost. The host
defines stable completion criteria for each pursuit and a single resource unit
across candidates and policy configuration. A source label is provenance, not
proof that different measurements are comparable. Changed criteria or resource
units require a new pursuit and compatible selector configuration.

For a normal SDK run, retain `run.tokenUsage` and `run.costInfo` as receipts.
`tokenUsage.totalTokens` can be the resource unit. If dollars are chosen,
`costInfo.unpricedTokens > 0` means the total is incomplete; do not report that
step as free. Include tool or validation costs when they matter. Selection
estimates are not a hard spending ledger: existing SDK token, cost, permission
and cancellation enforcement still belongs inside the step.

`DiskResidentAgenda.settleObserved(id, claim, decision, observation, now)` stores
the observation and disposition atomically against the exact admitted claim.
A failed observer or cancellation leaves work unresolved rather than recording
an unverified completion. Such a failure does not roll back effects or recover
missing receipts; the application must retain its execution records separately.
An observation's score does not override `decision.kind`: the host's step and
validator still own the actual completion criterion.

`ResidentPursuit.feedback?: ResidentFeedback` contains the last eight
observations, the best validated progress, consecutive stagnant steps and a
durable `hasUnobservedSteps` flag. The running claim fixes each observation's
admission number. A gap such as observed steps 1 and 3 cannot silently hide the
unobserved second step; measured selection defers it even after history eviction.
This prototype has no automatic metric-reconciliation API.

For each observation, credited gain is `max(0, progress - bestProgress)`.
Reusing an evidence key in the last eight observations earns zero gain; the
step's real cost remains counted in its observation. The persistent best also
prevents an older replay with its original progress value from earning credit.
This is not a permanent receipt-ID deduplication ledger. The host must reject
forged measurements, incompatible criteria and reused IDs with altered claims.

## Explainable selection and abstention

`createResidentSelector(ResidentSelectionConfig)` returns a `ResidentSelector`.
Required parameters are `progressValue`, `initialExpectedProgress` and
`initialExpectedCost`; `maxStagnantSteps` defaults to 2 and accepts 1–32.
The first three are host estimates in compatible utility/resource units, not
facts learned by the kernel.

The selector only considers due waiting pursuits. It rejects missing or gapped
observations, recent unknown costs, and pursuits reaching the stagnant-step
bound. For the remaining candidates:

```text
G = sum of credited gains in the last n observations, n <= 8
estimated cost = mean observed cost, or initialExpectedCost before observation

estimated gain = initialExpectedProgress
                 if untried, or during the bounded initial no-gain probes
estimated gain = (G + initialExpectedProgress) / (n + 1)
                 otherwise

score = progressValue * estimated gain - estimated cost
```

The extra prior observation smooths sparse measurements. It is an engineering
regularizer, not a Bayesian posterior. A score must be strictly positive.
Score ties use fewer admitted steps, earlier wake time and then UUID. This
policy provides no starvation bound. Every `ResidentCandidate` exposes its
estimate, score and rejection reason; `ResidentSelection` identifies the chosen
pursuit or explicitly chooses no useful work.

The result is bound to `agendaRevision`. `executionAt(id, snapshot)` refuses
admission if any agenda change occurred since selection; the host returns
`contended` without executing the callback. A caller may then start a fresh,
authorized invocation. Observer settlement may still retry unrelated agenda
write contention while preserving the exact target claim.

Abstention returns through the normal host wait logic: it preserves future wake
times and rechecks notifications received during an asynchronous snapshot read.
Rejected due work does not create a zero-delay busy loop. An idle result may
carry `selection` explaining why nothing ran. `wake` supplies fresh scheduling
evidence, but does not erase stagnation or repair missing metrics automatically.

Alternative `ResidentAgendaStore` implementations can supply optional
`executionAt` and `settleObserved` methods. Configuring the respective host
feature without its atomic storage support fails explicitly. Existing stores
and two-argument host construction keep their previous behavior.

## Model-proposed subgoals

A `ResidentProposal` has a UUID, parent ID and exact parent revision, domain,
objective, reason and evidence key. `validateResidentProposal` checks a snapshot
without changing it. `DiskResidentAgenda.admitProposal(snapshot, proposal,
limits)` performs validation and creation in one revision transaction:

- The parent must exist and be waiting or complete. Running, blocked and stale
  parents are refused. Paused agendas cannot admit proposals.
- `ResidentProposalLimits.domains` is an exact host-supplied allowlist;
  `maxChildrenPerParent` is 1–8 and `maxDepth` is 1–4.
- A proposal UUID can be admitted once. Concurrent duplicate admissions cannot
  create two children. The 32-entry agenda limit includes terminal entries.
- `ResidentProposalOrigin` records the parent, source revision, evidence,
  domain, reason and depth. It survives later child execution and reopening.

A domain label does not prove semantic relevance and grants no tool authority.
The host must review or mechanically constrain the proposed objective against
its standing mandate before admission, then bind ordinary SDK permissions and
budgets. Creation starts no executor and cannot reopen a paused host. An
application can generate and admit a bounded follow-up without another user
message; there is no unlimited self-spawning loop or notification transport.

Agenda schema 2 records feedback and ancestry. Schema-1 records read without
invented observations; later writes use schema 2. Older writers refuse these
new records rather than silently removing fields. Nested feedback and ancestry
are immutable; invalid persisted ancestry and observation ordering fail reads.

## Reproducible evidence and limitations

After building the SDK and the Zen driver:

```bash
node research/resident/selection-eval.mjs
node research/resident/initiative-live.mjs
node research/resident/initiative-live.mjs --live
```

The selector evaluation uses paired copies of the same initial agenda, the same
12-admission cap and an external fixture ledger. It compares default fairness,
fixed priority, measured selection and a patient configuration. Productive,
stalled, expensive, delayed and fluctuating-progress fixtures expose both gains
and failures. Current progress, completion, callbacks and simulated resource
units are separate metrics. Fixtures were used during development, including
mean smoothing: this is a regression and sensitivity study, not an independent
generalization result. Source/build fingerprints and complete scoring rules are
retained in `research/resident/results/2026-09-11-selection.json`.

The final development/stress run contains 128 paired-policy trials and 48 idle
checks with zero inference. Totals across the fixture tasks:

| Policy | Verified completions | Callback calls | Simulated resource units |
| --- | ---: | ---: | ---: |
| Default fairness | 40 | 220 | 388 |
| Fixed priority | 34 | 220 | 325 |
| Measured, patience 2 | 8 | 104 | 160 |
| Measured, patience 4 | 24 | 168 | 224 |

Patience 4 finishes the fluctuating-progress fixture, but still abandons the
five-step delayed payoff after four calls. The controls finish it at five.
Thus these results do **not** justify replacing default fairness. Progress and
cost are separate report fields; lower spend is not labelled greater intelligence.

The live experiment used Muse Spark low effort. Two SDK calls ended with
`end_turn`, reporting 1,277 total tokens. The first found a missing script in a
synthetic package fixture and proposed a follow-up. The host checked the field,
admitted one child under its standing fixture-review mandate, reopened durable
state, and ran that child without another user message. The host saved a
structurally checked suggestion; it did not execute or certify the proposed
command. The final idle check made zero model calls. Raw outputs, usage,
selection explanations and ancestry are in
`research/resident/results/2026-09-11-initiative-live.json`.

The study shows why resource savings are insufficient evidence of improvement:
a shorter bootstrap misses delayed payoffs, and higher patience spends more
without necessarily finishing a difficult task. The measured policy remains
opt-in. Further promotion needs independent tasks, calibrated outcome criteria,
actual tool-cost accounting and comparison under matching budgets. Adaptive
preferences, learned policies, always-on hosting and proactive delivery remain
later stages of the resident-agent roadmap.
