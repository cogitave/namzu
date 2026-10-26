# Resident continuity and recursive self-improvement readiness

Assessment date: 2026-09-14. Namzu code inspected at `016ae22f`.
Status: research assessment and proposed next experiment. No RSI benchmark or
new automatic improvement loop was executed in this assessment.

Follow-up: the [learning-cycle implementation and Muse experiment](learning-cycle-results.md)
now connect candidate generation, paired review, activation, reopening and rollback.
That narrow acquired-convention experiment found equal accuracy for retained raw
experience and generated guidance; it does not establish recursive improvement.
The assessment below records the state at its stated revision.

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

## Verified status, 2026-10-26

Checked against `origin/main` at `0aa415967`. The comparison method is the
public paper "Harness^2: Recursive Agent Harnessing for an Open World"
(arXiv 2610.14224): candidate harnesses are proposed, executed, composed and
selected blind, with a library of experience kept across tasks. The assessment
above is a snapshot from 2026-09-14; this section supersedes its "Remaining
gap" column.

**Built.**

- Paired, confirmation-gated verification and the no-regression protection plan
  (`packages/sdk/src/eval/harness-verification.ts`, `harness-protection.ts`).
- The learning cycle from candidate to activation and exact-revision rollback
  (`packages/sdk/src/manager/resident/learning-cycle.ts`). It is `@experimental`
  and is reached only through the explicit command
  `namzu resident learn <file> --trust`. It is not on a default product path.
- Retained-failure discovery over a durable store.
- Recovery without dead ends: the turn ladders for a full context, an
  unsupported image, a reasoning-only reply and a provider fallback.
- Proposed-then-confirmed skills in the interactive terminal, and the deferred
  `code_analysis` tool over `@namzu/analysis`.

**Built on the learning cycle, 2026-10-26.** Conversations keep the failures and
recoveries they already classify as observations (a reference, a fixed one
sentence, local, 30 days). A leak tripwire refuses evaluator-side material in
evidence and candidates. An experience library with a typed edit ledger keeps
what each cycle tried and how it ended. A built-in generator proposes one
revision of one instruction skill on an allowlisted surface, and a built-in
scenario evaluation checks it (blind grading, protection tasks, a fresh second
round). Owner update 2026-10-26: this runs by itself in the background of the
interactive terminal, on by default (`learningGenerator: false` turns it off),
bounded per cycle and per day, and every activation is exact-revision and
revertible with `namzu learn --undo`. The generic cycle (`runLearningCycle`)
stays `@experimental`, and `namzu learn <module> --trust` still runs a
host-supplied experiment.

**Missing.**

- Fan-out: propose several candidates, execute each, compose, select blind. The
  cycle handles one candidate per run.
- Blind, anonymised selection among candidates (the evaluation's grading is
  blind between the two sides, not a selection among many).
- Lessons written by the generator (cue, evidence, confidence). The ledger and
  verdicts are recorded; lessons are not yet produced.
- Failure-gated triggering beyond a count of new observations.
- Authoring of Namzu's own tools, hooks, agents or configuration, editing its
  own source, and recursive improvement of the improvement procedure. None is
  started, and the Muse experiment found retained raw experience as accurate as
  generated guidance, so the payoff of a generator is unproven for Namzu. The
  built-in evaluation's scenarios are fixed and general; it can show that a
  revision does no harm and changes recovery behaviour, not that it helps a
  project's own tasks.

**Cost control.** `resources` (a unit and a maximum number of units) and usage
receipts bound what one cycle may spend. The built-in generator sets it to 120,000
tokens by default, keeps a daily allowance of 300,000, requires 5 new
observations and a 6 hour pause before it starts by itself, and waits for an
idle conversation before each model call.

### Staged plan

Order: 0, 1, 3, 2, 4, then measure. 5 and 6 only if 4 shows a gain.

| Step | Work | Safety floor |
| --- | --- | --- |
| 0 | This status, and the cost label above | None touched |
| 1 | Bridge from failures and recoveries the runtime already classifies to observations: references into the session log, a short redacted summary, local only, pruned after 30 days, a config key turns it off | Observations only, no activation |
| 3 | Leak tripwire for candidates (evaluator and answer canaries, grader-verdict markers) | It is part of the floor |
| 2 | Experience library and typed edit ledger beside observations | Read-only data, pinned evaluator revision |
| 4 | Built-in generator, single surface (instruction skills). Owner update 2026-10-26: automatic in the background and on by default, a config key turns it off; spend bounded per cycle and per day; `namzu learn` runs a cycle by hand and lists or undoes what was learned | Allowlist is instruction skills only; permission review, protected paths, the dangerous-pattern floor and the learning code itself are never on the editable surface; activation is by exact revision, gated by paired verification and a fresh confirmation round, and revertible |
| 5 | Execute-and-compose with blind selection on the workflow tool | Candidates run sandboxed; paired verification still gates activation |
| 6 | Scheduled or failure-gated runs with mandatory per-job permissions | One run at a time |
| 7-8 | Parity workflow, self-source map and `code_navigation`; `@namzu/analysis` phase B | Read-only |
| 9 | Native analysis lane (Rust in CI and packaging are owner decisions) | Behind a config key |
| 10-12 | Own tools, hooks, agents and config with revisions; own-source edits in a managed worktree; recursive improvement | Safety floor never editable by itself; owner approval to switch |

Defaults chosen where the plan asked the owner, so they can be changed:
observations record only failures and recoveries the runtime already classifies
and are never uploaded. The generator was chosen opt-in, then changed by the
owner on 2026-10-26 to run by itself and be on by default.

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

## Learning discovery follow-up

[Retained-failure discovery](learning-discovery.md) now selects an eligible observation, claims one experiment atomically and reuses the verified learning cycle. A sequential Muse low study produced 6/10 to 10/10 on verification and 7/10 to 10/10 on fresh confirmation. This is a narrow result from retained failure plus host correction; the meta-level selection procedure remains engineered, not learned.

## Transfer boundary

[Cross-task guidance diagnostics](learning-transfer.md) found that the same
accepted skill can add unnecessary tools and cause a bounded task failure when
inserted into unrelated work. On-demand resident disclosure now allows relevant
skill selection while keeping source-revision checks and admitted-run ownership.
The live follow-up includes an unresolved provider request and a TUI case that
still over-explored. These are explicit limits, not a general transfer success
claim. Protected tasks from other families must be included in future learning
acceptance studies before broad activation.

## Preservation gate follow-up

[Predeclared preservation tasks](learning-protection.md) are now required for
resident learning and direct promotion. A fixed-candidate Muse low experiment
passed both rounds (8/10 to 10/10) while preserving all 16 unrelated trials. A
scripted counterexample with aggregate improvement and one collateral loss was
rejected. This closes an acceptance-coverage gap; representative task selection,
long-term interference and recursive improvement remain unproven.

## Open owner decision: learning without a resident

`namzu learn --sessions` reads the conversation observations and activates into the project's own guidance (a revisioned store beside them), which later conversations start with; with a host module that supplies the generator and the independent evaluation. Namzu's own generator needs no module: it runs by itself in the terminal and by hand through `namzu learn`.
