# Resident learning cycle: implementation and evidence

Date: 2026-09-14. Implementation builds on `bb65898d`. The live experiment used
only Zen `muse-spark-1.3-contributor-free`, effort `low`. No Luna requests were
made for this milestone.

Namzu now exposes one optional, host-authorized SDK workflow that generates
instructional guidance from a recorded failure, independently evaluates it,
requires fresh confirmation, and activates the exact evaluated content. A real
CLI process subsequently used the retained guidance. Explicit rollback removed
it from the next admission. This establishes the integration and the tested
acquired convention. The experiment did not demonstrate an accuracy advantage
over retaining the raw correction or improvement of the learning procedure.

## Implementation

[`runResidentLearningCycle`](../../packages/sdk/src/manager/resident/learning-cycle.ts)
composes existing agenda transactions, `reviewHarnessCandidate` and admitted
learning context. The host owns generation, evaluation and durable event storage;
there is no second inference runtime or newly installed autonomous daemon.
The [public contract](../../docs/sdk/resident-learning-cycle.md) documents:

- Declared candidate ancestry, original failure and exact baseline/candidate
  hashes in a sequenced event journal. Failed attempts retain known consumption.
- Separate verification and fresh confirmation, with five paired task families
  and two trials per side in each round. The candidate cannot attest to its own
  success. The host still authenticates the evaluator and task separation.
- Explicit incomplete/unpriced usage, duplicate receipt refusal, resource
  exhaustion, cooperative cancellation and stale-agenda refusal.
- Atomic promotion against the original revision; ambiguous commit acknowledgement
  is inspectable and never causes automatic replay. A final journal failure cannot
  turn an acknowledged activation into a reported uncommitted failure.
- Reuse of existing learning projection and explicit rollback after reopening.

The resource allowance prevents subsequent work or activation after observed
excess/incomplete evidence. It is not an atomic reservation or in-flight cap.
Each host callback must limit its own model/tool executions and record every
non-overlapping run, including generation, controls, failed cases and reviewers.

The design follows the proposal/evaluator separation and persistence controls in
the [RSI source assessment](rsi-readiness.md). No upstream benchmark score is
presented as a Namzu result, and no model weights or executable skill code change.

## Experiment design

The [producer](learning-cycle-experiment.mjs) creates an isolated workspace and
Namzu home. An actual CLI `resident add` initializes its agenda. The SDK then uses
that same agenda, rather than copying a skill into an unrelated test store.

The task is a synthetic, host-defined destination convention. It preserves ID
case and leading zeroes, routes sealed records into `hold`, and routes invoices
and memos into distinct year/month paths. Cold behavior lacks this convention
and is instructed to return `UNKNOWN`. Its mismatch with the host's expected
destination is recorded; the host supplies an authoritative corrective trace.
This is an observed knowledge gap, not evidence of a defective model or a failure
discovered without host feedback.

Muse generates the guidance text from that trace. Verification and confirmation
tasks are declared before generation and are not supplied to the generator.
Each arm uses fresh SDK runs with the same model, effort and empty tool registry:

1. **Frozen:** no experiment-derived convention or previous conversation.
2. **Raw memory:** the complete observed input/output and host correction.
3. **Generated guidance:** the candidate's reusable instructional body.

An external exact-path scorer checks outputs through `runExperiment`; no LLM
grades them. Verification and confirmation use different IDs and trace/condition
identities, covering the same five routing families. Four further held-out inputs
cover invoice and memo paths after reopening; they are related variants, not a
new domain. The primary promotion comparison is guidance versus frozen behavior.
The raw-memory arm tests whether simple retention explains the same gain.

Runs are bounded to 80 SDK calls, 2,400 tokens and 45 seconds per SDK call,
one model iteration per SDK call, and a 15-minute overall signal. The separate
CLI admission allows one resident step, three iterations and 16,000 tokens, with
a two-minute subprocess timeout. The cycle's recorded allowance is 180,000 tokens.
These are experiment limits, not new ordinary CLI defaults.

## Observed live results

The completed run lasted **168.944 seconds**, with 75 SDK runs and one separate
CLI resident admission. All SDK runs ended with `end_turn`.

| Phase | Frozen | Raw memory | Generated guidance |
| --- | --- | --- | --- |
| Verification | 0/10 | 10/10 | 10/10 |
| Fresh confirmation | 0/10 | 10/10 | 10/10 |
| Held-out variants after reopening | 0/4 | 4/4 | 4/4 |

The paired gate accepted candidate
`c35a3e42177272b0a37e09c14f5e5944072ef54fb43387132f60efd267301d33`
under cycle `5959f0fa-248a-4565-9e85-2b85a05941a7`. The candidate is retained
verbatim in the [audited live summary](results/2026-09-14-learning-cycle-muse.json).

The independently launched CLI loaded that hash and evidence key from disk. Its
new input produced the exact expected summary, `finance/2033/08/ReOpened-07.json`.
The persisted CLI run metadata records provider `zen`, the Muse model and `low`
effort; its request envelope confirms that model. The foreground worker stopped
after one settled admission. A later PTY `resident inspect` also exited zero and
displayed the retained consumption. No personal resident was modified.

CLI completion was checked by this experiment. Its resident receipt explicitly
has `verification: unconfigured`; it must not be described as a configured kernel
claim-verification receipt. After rollback the active skill list was empty and a
fresh SDK invocation returned `UNKNOWN` again.

| Recorded work | Tokens | Price evidence |
| --- | ---: | --- |
| Candidate generation | 754 | Unpriced |
| Verification, all three arms | 12,889 | Unpriced |
| Confirmation, all three arms | 12,613 | Unpriced |
| Cycle subtotal: 61 execution receipts | 26,256 | 61 unknown-cost receipts |
| Other SDK work: cold case, holdout, rollback check | 5,827 | Unpriced |
| All 75 SDK runs | 32,083 | All tokens unpriced |
| Separate CLI admission | 8,804 | All tokens unpriced |
| SDK plus CLI | **40,887** | **No dollar-cost claim** |

The cycle subtotal is included in the SDK total. The CLI's own and descendant
totals are equal here and are counted only once. Numeric zero price fields in the
older evaluator summary do not mean free work; the cycle explicitly preserves
unknown costs and used a token policy. Actual provider billing is not established.
There were no model requests for the scripted control or read-only artifact audit.

For the 20 verification/confirmation inference runs, guidance consumed 8,538
tokens versus raw memory's 10,083, a difference of 1,545 (15.3%) at equal accuracy.
This excludes generation and evaluation overhead, uses a fixed arm order and a
small single run, and is not a net-saving or statistically established result.

## Reproduction and artifact audit

After building the workspace:

```sh
node research/resident/learning-cycle-experiment.mjs
node research/resident/learning-cycle-experiment.mjs --live
node research/resident/learning-cycle-audit.mjs /path/printed/by/the/producer
```

The first command uses an explicit mock provider. The second makes bounded Muse
requests and runs the actual CLI admission. The third makes no model requests;
it rechecks retained output scores, paired-review acceptance, journal sequence,
receipt identity/consumption, candidate hash, held-out outputs and rollback.
It requires the producer's complete directory, not only the compact summary.

Retained development artifacts:

| Artifact | Location |
| --- | --- |
| Full Muse records | `/tmp/namzu-learning-cycle-pkFLKo` |
| Exact executed live producer | `/tmp/namzu-learning-cycle-pkFLKo/producer.mjs` and `producer-sha256.txt` |
| Current scripted control | `/tmp/namzu-learning-cycle-Nq5NR9` |
| Audited live summary | [Muse JSON](results/2026-09-14-learning-cycle-muse.json) |
| Audited scripted summary | [Control JSON](results/2026-09-14-learning-cycle-control.json) |

Each complete directory retains `result.json`, `cycle.jsonl`, `runs.jsonl`, the
attempt ledger, both full evaluation batches and isolated resident state. The
compact summaries preserve result hashes and five runtime build fingerprints.
The runtime fingerprints did not change during the live run and match the
implementation tested here. Temporary artifacts are local evidence, not a
durable public archive or a promise they survive machine cleanup.

After the live run, the producer's cancellation wiring was tightened to forward
case/subprocess signals; the SDK implementation stayed unchanged. The final
scripted control exercised the current producer. The original executed live
recipe is retained separately, so the later wiring is not presented as live-tested.

## Regressions and checks

The new 22-test SDK suite covers acceptance, rejection, fresh confirmation,
declared ancestry, incomplete evidence, duplicate UUID aliases, cancellation,
concurrent agenda changes, journal failure, lost commit acknowledgements and
reopening/rollback through admitted context.

A development regression showed that a host callback could catch a rejected
duplicate usage receipt and still reach activation. The stage now retains that
error and refuses the candidate even when the callback suppresses it. A separate
experiment setup error passed an array where `ToolRegistry` was required; it
failed before any live request and was fixed before the recorded Muse run.

Workspace typecheck, lint, build and tests passed. The SDK suite passed 6,847 tests;
the CLI passed 3,052, with five existing skips. SDK process tests passed 266.
SDK coverage and its module floors, public signature exports, documentation
conformance and documentation fences also passed. Final focused checks include
the strengthened ancestry and failed-attempt journal assertions. These establish
the tested contracts; they are not a claim that every release/publish gate ran.

## Remaining evidence gap

The integrated acquisition path is available to an SDK host and its accepted
guidance reaches existing CLI resident admissions. The CLI does not automatically
invent its own learning experiments. The next research question is whether
guidance improves real tool decisions beyond raw memory on withheld failures,
without weakening file/permission guarantees or losing delayed-payoff tasks.
That requires stronger task diversity, stale/irrelevant-guidance controls,
repeated candidates and full discovery/evaluation cost accounting. Improving the
candidate generator across generations remains unproven.
