---
type: Reference
title: Paired harness verification
description: Compare recorded harness trials and require behavioral evidence before accepting a candidate.
resource: packages/sdk/src/eval/harness-verification.ts
tags: [sdk, evals, harness, verification]
---

# Paired harness verification

`compareHarnessTrials` and `reviewHarnessCandidate` consume host-owned
`CaseResult` records from `runExperiment`. They do not execute models, edit
configuration, or apply a winning candidate. Existing experiment behavior is
unchanged.

Each `HarnessTrial` carries a task ID, trial index, trajectory ID and a
`conditions` fingerprint. The host must include model, environment seed,
inference limits and scorer configuration in this fingerprint, run each side in
an isolated environment, and retain the cited trajectories. The SDK checks
pair identity, equal fingerprints, unique traces and distinct trial conditions;
it cannot prove that the host actually enforced those conditions.

`compareHarnessTrials` labels tasks `recovered`, `stable-success`, `regressed`,
`still-failing`, `mixed`, or `inconclusive`. It reports the paired trial pass-rate
difference and actual recorded tokens, USD cost, summed duration and rollout
count for both sides. Duration is accumulated run time, not concurrent wall
time. Analysis/reviewer costs are not included. Failed measurements and execution
errors produce an inconclusive comparison, not an invented recovery.

`HarnessAttribution` links an explanation and an improvement, regression or
unresolved finding to trace IDs on both sides of a task. Unknown or foreign
references are rejected. References make a claim auditable; the independent
reviewer remains responsible for checking its truth. A score increase alone
does not supply attribution.

`reviewHarnessCandidate(verification, confirmation?, protection?)` returns `accept`, `reject`
or `inconclusive` and both comparison reports. Acceptance requires:

- At least five distinct verification tasks, exactly two paired trials each.
- Trace-attributed recovery, or stable success with a larger success count.
- No observed or attributed regression, unavailable measurement or mixed outcome.
- A same-size confirmation using the same two revisions, fresh conditions and
  trace IDs, and at most two reused tasks.
- Attributed improvement and a strictly positive pass-rate difference in confirmation.

Missing confirmation is inconclusive. Neither preservation nor an aggregate
gain can conceal a regressed task. Unknown attribution is never manufactured
from tool names or rewards. This is a recorded-evidence decision, not a
statistical guarantee or proof of generalization; keep final TEST tasks outside
selection and review.

## Declared preservation tasks

The optional third argument, `HarnessProtectionPlan`, names `verification` and
`confirmation` task IDs that must preserve an existing capability. Each array
contains 1–63 distinct, nonempty IDs (at most 256 characters each); the two arrays
must be disjoint. IDs match exactly, without keyword-based task classification.
The host selects meaningful unrelated or previously successful tasks **before**
generating a candidate, keeps confirmation inputs private, and includes every
named task in its designated round. The pure reviewer cannot authenticate that
selection time or the semantic diversity of tasks.

Each named task needs exactly two successful, measured baseline trials and two
successful candidate trials. A missing task, uncertain result or unsuccessful
baseline makes preservation inconclusive. Losing even one of the two established
baseline successes rejects the candidate, even when the aggregate score rises.
Preservation cannot replace the separate requirement for attributable improvement.
`HarnessReview.protection` reports each round's status plus `missingTasks`,
`unprovenTasks` and `regressedTasks`. A round that has not run has no check.

Generic reviews may omit this plan. [Resident learning](resident-learning-cycle.md)
and direct resident skill promotion **require** it, snapshot it, and retain its
identity with the activation evidence. No extra model calls occur in the reviewer.
This strict finite-sample gate is not a statistical non-inferiority test: it can
withhold a useful candidate because of noise, and cannot rule out untested harms.
Resource or tool-efficiency constraints must be part of the host's task scorer if
they are intended to block acceptance; a correct answer alone does not prove efficiency.

## Research basis and scope

[HarnessLens, arXiv:2608.27311v1](https://arxiv.org/html/2608.27311v1),
particularly §4.3 and Appendix A.4, motivates paired behavior classification,
attribution and fresh confirmation. Namzu implements these deterministic
verification primitives. Its policy is deliberately more conservative:
unattributed observed regressions and mixed outcomes also block acceptance.

This is not a reproduction of the full evolution controller. Automatic proposal
generation, behavior-aware task selection, budget reservation and independent
trace diagnosis remain host responsibilities. The paper's benchmark gains are
not Namzu measurements. Its experiments cover one model family and count
interaction units rather than normalizing dollar or token cost. The current
primitives make such measurements inspectable without adding inference calls
to ordinary agent turns.

## Local validation

On 2026-09-08 the decision functions were exercised against the actual
`c635b5a4` conversation-search implementation and the paged implementation.
Two disjoint five-case fixture batches, with two paired trials each, produced
40 local executions. Each batch contained three large archives and two small
preservation cases: the large archives became recoverable and the small cases
remained successful. The gate accepted both rounds with trace-linked evidence.
These are deterministic synthetic retrieval checks, not model benchmark gains.

A separate real TUI session using `gpt-5.6-luna` at low effort recovered a
previously unseen UUID at event 13 of a synthetic 12 MiB archive in two tool
calls, without tool errors. The initial live attempt exposed a continuation that
rejected a redundant repeat of its own scope id; a matching single-scope
continuation is now accepted and
covered by a regression assertion. The TUI check tests model/tool integration;
it does not establish general long-horizon reasoning performance.
