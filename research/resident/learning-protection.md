# Resident learning: preserving other tasks before activation

2026-09-14. Base `f92daf81`; implementation and runtime evidence accompany this
report. This extends the [transfer diagnostic](learning-transfer.md). Namzu now
requires host-selected preservation tasks before a resident learning experiment
can activate new guidance. It does not establish recursive self-improvement,
train weights, or guarantee behavior on untested tasks.

## Evidence and design

[HarnessLens §4.3 and A.4](https://arxiv.org/html/2608.27311v1) separates
conversion, positive-control and preservation tasks, uses paired trials, and
requires fresh confirmation before an update. Its task selection is richer than
a minimum batch-size check. Namzu's previous reviewer already blocked measured
regressions but allowed every task in a resident experiment to come from one
narrow capability. A batch could therefore miss the collateral damage observed
in our fixed-guidance diagnostic.

[When Continual Learning Moves to Memory, §2–4](https://arxiv.org/html/2604.27003v1)
measures transfer and forgetting separately from within-task success. Its
ALFWorld/BabyAI results motivate testing retained capabilities alongside new
ones; they are not Namzu measurements. We implement a conservative engineering
gate rather than reproduce its training protocol or claim statistical
non-inferiority.

The host fixes `protection.verification` and `protection.confirmation` before
candidate generation. The SDK validates, clones and freezes both arrays, records
them in the starting event, and excludes them from the generation context.
IDs identify exact host-owned tasks; the kernel does not infer semantic families
from labels. The pure direct-promotion API requires the same plan and repeats
the same gate, although it cannot authenticate when an external host chose it.
Each declared control requires two successful measured baseline trials and two
successful candidate trials. Missing controls or uncertain baselines block
acceptance. Losing even one established success rejects the candidate; gains
on other tasks cannot offset it. Independent attributable improvement and the
existing fresh-confirmation rules remain required.

The activated skill stores control counts and a plan digest. The full plan
remains in the journal and is bound into the evaluation digest. Historical
skills remain readable without retroactively adding preservation evidence.
This is a breaking admission contract for resident learning hosts and direct
promotion callers; see the changeset and SDK documentation. Generic harness
reviews can opt in with the third argument.

## Fixed-candidate live experiment

The candidate is the unchanged guidance accepted in the earlier source-selection
experiment, SHA-256
`dcfd9b331994021ba72c40c71d01dec44ec81954766c812a2df70800a8a21103`.
A deterministic host operation selects that existing content; **there is no new
model-generated candidate in this experiment**. Its zero-token receipt is marked
as a host operation, separate from model runs.

Both rounds contain five task groups with two trials each: one current-source
selection group plus document reading, local configuration overrides, CSV
arithmetic and exact file append/preservation controls. Confirmation changes
values and filenames. The specification and protection selection are saved
before execution. Within each pair, model, effort, fixtures, tools, context
protocol and limits match. Arm order rotates; runs execute sequentially without
retries. The candidate uses the actual `createResidentStepContext` on-demand
protocol; the baseline has the same resident context without the skill catalogue.

Scoring requires an exact answer, successful required file reads, an exact
complete final file manifest, `end_turn`, and settled usage. Source attributions
are host checks of retained outputs and tool traces against the designated
fixture source; they are not model-authored self-evaluations or causal proof.
Each run is explicitly limited to 8 iterations, 24,000 tokens and 120 seconds.
These experiment guards do not change the CLI's default unlimited settings.

The [complete live artifact](results/2026-09-14-learning-protection-muse.json)
retains all 40 runs, the plan, event sequence and activated state:

| Round | Baseline | Candidate | Protected trials, each arm | Baseline tokens | Candidate tokens |
| --- | --- | --- | --- | --- | --- |
| Verification | 8/10 | 10/10 | 8/8 | 124,436 | 123,681 |
| Fresh confirmation | 8/10 | 10/10 | 8/8 | 101,302 | 119,903 |
| Total | 16/20 | 20/20 | 16/16 | 225,738 | 243,584 |

Both rounds passed the gate; cycle
`137522c3-00af-4095-af3b-cf7062d56927` activated the fixed candidate in the isolated
resident. Baseline source selection failed four times; candidate source selection
passed four times and loaded the guidance in those four runs. No unrelated
control loaded it. Baseline used 56 tool calls, candidate 51; no tool call failed.
Candidate recorded token consumption was about 7.9% higher overall. Thus this is
not evidence of a general efficiency gain. All 40 usage receipts settled, totaling
469,322 recorded tokens; all 40 model price receipts are unknown. The numeric
zero in the legacy `CaseResult` cost field is not a free-service or billing claim.

## Actual terminal and controls

The [TUI artifact](results/2026-09-14-learning-protection-tui.json) records the
built CLI in a 120×34 pseudo-terminal, with Muse low selected via `/effort low`.
A natural-language request containing the exact host command started one
background `resident learn` process. The parent read incremental output, received
the exit notification, and correctly reported both protection rounds and the
activated cycle. It did not restart the experiment. The parent consumed another
57,725 recorded tokens, separate from the child cycle; combined recorded usage
was 527,047 tokens. Default parent token/iteration/time limits remained zero
(unlimited), and its usage settled with `end_turn`.

The approval path required one command approval and three more approvals to read
that same background job. This is observed UX friction: the current `job` tool
has static `shell_execute` permission and `readOnly: false` for all actions.
Separating read/list observation from stop authority is a concrete follow-up;
this learning-gate change does not silently change permissions. A startup
computer-use warning came from the deliberately restricted PATH and is not a
computer-use test.

Two independent scripted CLI controls exercised real file tools and storage:

- [Successful control](results/2026-09-14-learning-protection-control.json): 40
  deterministic runs; both rounds 8/10 → 10/10, controls passed, activated.
- [Regression control](results/2026-09-14-learning-protection-regression-control.json):
  20 deterministic runs; candidate improved 8/10 → 9/10 overall but lost one
  protected document result. Rejected before confirmation, no active skill.

These controls use mocked model responses and zero model tokens. They establish
execution paths and rejection behavior, not model competence. Unit tests also
cover missing plans before inference, missing round controls, invalid/reused
IDs, unsettled evidence, mutation attempts, direct promotion, fresh confirmation
loss, proof persistence and unchanged cancellation/resource gates.

## Reproduction and limits

From the repository, build the packages first, then run:

```sh
node research/resident/learning-protection-study.mjs
node research/resident/learning-protection-study.mjs --regression
node research/resident/learning-protection-study.mjs --live --prepare
```

The last command prints an isolated home, workspace and `.learning.mjs` host.
Start the built TUI with that `NAMZU_HOME` and working directory, select Muse low,
and ask it to run the printed host once via `resident learn <absolute-host> --trust`.
`node research/resident/learning-protection-study.mjs --inspect <root>` reopens
SQLite and independently recomputes scores from the retained runs and manifests.
There is no automatic retry. Historical pre-protection studies must be replayed
at their recorded revision (for example `f92daf81`), not relabeled as having passed
this gate.

Workspace typecheck, lint, build, documentation conformance/fences, exported
signature types and SDK test-presence checks passed. Lint retains pre-existing
workspace warnings; release coverage and consumer-install gates were not run.
No push or publication is implied.

The full workspace suite passed after moving test temporaries to a private
`TMPDIR` on `/dev/shm`: 6,898 SDK tests and 3,121 CLI tests, with five existing CLI
skips, plus all other package suites. The first broad attempt failed with
`ENOSPC` on the nearly full workspace disk; its log was retained and no scores
were discarded from the live experiment. All 40 live runs have settled records.
The disk issue is not a passing test and not a learning improvement. No personal
or unrelated experiment data was deleted.

Remaining scientific limits: these are small, simple fixtures with explicit
host labels and known answer checks. They do not test autonomous selection of
representative controls, long-term interference among many skills, adversarial
scorers or statistically robust transfer. The strict finite-sample gate can
reject useful guidance because of model noise. CPU load overlapped local unit
tests; timing is not a performance claim. Token efficiency is recorded, not an
acceptance objective here; hosts must encode such constraints in scorers if
required. Broad applicability still needs separate evidence.
