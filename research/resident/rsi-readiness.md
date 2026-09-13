# Resident continuity and recursive self-improvement readiness

Assessment date: 2026-09-14. Namzu code inspected at `016ae22f`.
Status: research assessment and proposed next experiment. No RSI benchmark or
new automatic improvement loop was executed in this assessment.

## What the completed work establishes

The [lifetime audit](lifetime-accounting.md) establishes retained execution and
consumption evidence across controlled restarts, interruption, reconciliation
and archival. Its two-hour lifecycle used a scripted provider; the separate
three live CLI trials used six Luna/low requests. These establish the tested
runtime integration, not improved problem-solving ability or sustained live
learning. Missing final usage remains unknown. The new inspector is read-only;
it does not impose a lifetime spending cap.

The current resident capabilities have different evidence levels:

| Capability | Current implementation and evidence | Remaining gap |
| --- | --- | --- |
| Continuity | Durable agenda, exact execution claims, explicit recovery, managed CLI worker; sustained lifecycle audit | More deployment environments and longer operational evidence |
| Outcome and resource accounting | Scoped verification receipts and bounded history/usage inspection | A receipt proves its historical check; incomplete consumption cannot be reconstructed |
| Behavioral adaptation | Versioned profile, evaluated text guidance, rollback, admitted context | Existing live preference test is host-supplied correction, not autonomous skill discovery |
| Task selection | Optional host-observed progress/cost heuristic | CLI still uses default fairness; heuristic has documented delayed-reward failures |
| Self-improvement | Paired candidate review and durable skill activation primitives | No integrated resident loop generating, independently evaluating and promoting its own candidates |
| Recursive improvement | No demonstrated improvement of the improvement procedure | No cross-generation or cross-domain evidence |

Code checked: [learning](../../packages/sdk/src/manager/resident/learning.ts),
[activation transaction](../../packages/sdk/src/manager/resident/agenda.ts),
[paired review](../../packages/sdk/src/eval/harness-verification.ts), and
[actual CLI host](../../packages/cli/src/integrations/resident/foreground.ts).
The CLI enables admitted learning but does not configure the measured selector.
Production call-site search finds skill promotion in the SDK transaction, not
an automatic CLI candidate-generation and evaluation service.

The existing review requires five tasks with two trials per side and a fresh
confirmation round. It checks paired conditions, trace attribution and observed
regressions. The host still owns evaluator integrity and execution. It is not a
statistical guarantee of generalization. Instruction text is the promoted
artifact; model weights and executable skill code are not changed by this API.

An important negative result already exists in
[selection evidence](../../docs/sdk/resident-initiative.md): default fairness
completed 40 fixture pursuits; measured selection with patience two completed
8 while spending less. Patience four completed 24 and still missed a delayed
payoff. Lower consumption alone cannot justify promotion. Those figures are
development fixtures, not current production success rates.

## Research with a direct architectural consequence

**Darwin Gödel Machine** evolves coding agents through code modifications,
evaluation and a branching archive. Its reported objective-hacking example
improved a metric by removing tool-use logging markers. Namzu should preserve
candidate ancestry and failures, while keeping authoritative outcome evidence
outside the candidate's editable artifacts. This is an empirical optimization
method, not a proof of unrestricted recursive progress.
[Paper and implementation link](https://arxiv.org/html/2505.22954v2).

**Hyperagents** makes both task behavior and the meta-agent modification
procedure editable. This supplies a useful stronger test: does an improved
modifier produce better descendants on previously unseen problems? Source at
`59a68f672dfb92c74aeb7e61535d776fb36e172d` separates generation, evaluation and
archive updates. Its initial editable parent selector actually chooses randomly
among eligible scored parents; reading the code matters before attributing a
sophisticated learned selection policy to the scaffold. Namzu has not reproduced
these experiments.
[Paper](https://arxiv.org/abs/2603.19461),
[generation loop](https://github.com/facebookresearch/HyperAgents/blob/59a68f672dfb92c74aeb7e61535d776fb36e172d/generate_loop.py),
[initial selector](https://github.com/facebookresearch/HyperAgents/blob/59a68f672dfb92c74aeb7e61535d776fb36e172d/select_next_parent.py).

**GEPA** is the closest initial implementation model: use execution feedback to
propose improved textual components and retain candidates with complementary
strengths. At `15ee314f9c7d34ec153b809d401f42f55c4dcd76`, the reflective proposer
returns evaluated proposals, the engine owns acceptance, and candidate selection
includes a Pareto implementation. Namzu can retain this separation using its
existing guidance hashes, evaluation gate and activation transaction. No GEPA
dependency or Python runtime is required by this recommendation.
[Paper](https://arxiv.org/abs/2507.19457),
[proposer](https://github.com/gepa-ai/gepa/blob/15ee314f9c7d34ec153b809d401f42f55c4dcd76/src/gepa/proposer/reflective_mutation/reflective_mutation.py),
[selector](https://github.com/gepa-ai/gepa/blob/15ee314f9c7d34ec153b809d401f42f55c4dcd76/src/gepa/strategies/candidate_selector.py).

**PAST-Bench**, submitted August 2026, tests persistent experience across fresh
sessions with matched persistence-on/off conditions. It checks memory,
procedural reuse, information gathering and correction, including traces showing
whether the intended mechanism was used. Its 26 synthetic scenarios are a useful
evaluation design, not evidence that Namzu passes them. The authors also report
uneven gains and an aggregate Hermes+ difference smaller than run variation.
[Paper](https://arxiv.org/html/2608.04003v1).

**SEAL** generates adaptation data and directives whose supervised updates change
model weights, with reinforcement learning training the self-edit process. This
would require a trainable model and an additional training backend. Persisting
guidance in Namzu's context is a different mechanism; subscription provider
integration alone does not implement SEAL.
[Paper](https://arxiv.org/abs/2506.10943).

Primary articles and selected author-owned source files were read. Upstream
experiments were not run and their benchmark scores are not Namzu scores.
Downloaded source snapshots are retained locally under
`/tmp/namzu-rsi-source-mwat4b0y`; no upstream code was installed or executed.
GEPA's full arXiv HTML exceeded the browser limit, so its abstract and pinned
implementation supply the claims above.

## Proposed next milestone: demonstrate one acquired improvement

Start with automatic generation of a bounded instructional skill from a real
failure trace. Keep the base provider/model fixed. Reuse existing resident
admission, experiment execution, paired review, skill hashing, activation and
rollback instead of building another agent loop.

Compare three controlled configurations in fresh sessions:

1. Frozen behavior without retained experiment experience.
2. The same behavior with retained experience, but without candidate generation.
3. Retained experience plus generated, evaluated guidance.

Use matching tasks, tools and inference settings, and separate development,
confirmation and final holdout problems. Remove every experiment-derived state
channel in the first control, including history search and saved files. Trace
which candidate was actually admitted and used; a stored artifact alone is not
successful transfer. Keep stale-correction and irrelevant-skill controls.

The first candidate should address a narrow, externally checkable Namzu failure,
such as choosing a suitable read/search action for a known workspace condition.
Then test related problems with changed paths and wording. Hard file-consistency
or permission requirements remain kernel contracts; learned instructions cannot
replace those guarantees.

Report verified completion, regressions, resource consumption and elapsed time
separately. Include candidate generation, rejected candidates and validation
work in experiment consumption. Missing price or usage must remain explicit.
The evaluator's current numeric cost summary needs a deliberate adapter for the
new inspector's incomplete/unpriced evidence; a zero-valued field is insufficient.
Use an explicitly bounded experiment even though ordinary CLI budgets need not
be fixed by default.

Success means a generated candidate passes the existing fresh-confirmation gate,
improves unseen tasks under the declared resource policy, survives reopening,
and can be rolled back. A few live calls establish wiring only. Repeated trials
and uncertainty estimates are necessary before claiming a general improvement.
The measured selector should receive a separate delayed-payoff study before any
default change.

The next, stronger experiment can allow revisions to the proposal strategy and
compare their downstream improvement yield under equal total experimental
budgets. That tests recursive improvement of the search process. It is premature
to label persistence or a single accepted skill as that result.
