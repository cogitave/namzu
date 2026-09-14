# Learning from self-selected environment experiments

2026-09-14. Base `9463b6f6`. This milestone addresses a specific gap in the
[previous experiments](learning-discovery.md): their generator received an
authoritative correction. Here the live explorer receives a failed prediction
and an executable preview tool. It chooses experiments and obtains observations
without a supplied correct answer or reusable skill.

## Research and architectural choice

[Voyager](https://arxiv.org/abs/2305.16291v2) combines automatic task selection,
environment feedback and a reusable skill library in Minecraft. Its
[execution loop](https://github.com/MineDojo/Voyager/blob/12025800790e16ddc9e4f61de18863859b4edf31/voyager/voyager.py)
passes observed events and critique into subsequent actions, and stores skills
after successful execution. This motivates acquiring evidence through actions
before synthesis. Namzu does not implement its Minecraft environment, automatic
curriculum or executable skill library, and does not inherit its benchmark gains.

[HyperAgents](https://arxiv.org/html/2603.19461v1) distinguishes improving a task
agent from modifying the procedure that produces later improvements. Its
[generation loop](https://github.com/facebookresearch/Hyperagents/blob/8172fedda690dcc8347996fd12da2fdc9bb098a3/generate_loop.py)
handles candidate evaluation, archive state and selectable parent policies.
The practical consequence is to measure future improvement yield if an explorer
or proposer is later changed. The current Namzu experiment keeps those policies
fixed; it is not a replication of metacognitive self-modification.

GEPA's
[reflective proposer](https://github.com/gepa-ai/gepa/blob/ef525a44626a725b6987a35b4a75e36fbfaf0e25/src/gepa/proposer/reflective_mutation/reflective_mutation.py)
builds proposals from execution feedback and returns evaluated candidates to its
engine. Namzu retains its own separation of exploration, synthesis, independent
evaluation and activation. It does not add GEPA as a dependency or claim its
search algorithm. Pinned source hashes are retained alongside the experiment.

The reusable SDK change is an optional `explore` stage in the existing resident
learning cycle. It shares cancellation, accounting and revision checks, retains
bounded observations and their digest, and passes an immutable copy to generation.
No separate model loop is introduced. An incomplete stage or failed journal
append prevents synthesis; generation cannot replace the predeclared preservation
plan. CLI learning hosts forward the stage and show its progress. The
[public contract](../../docs/sdk/resident-exploration.md) specifies the boundaries.

## Predeclared experiment

The synthetic service previews a destination for a record with kind, date,
identifier and sealed status. Its namespace and kind aliases are generated from
a fresh seed. The service code is available only to the host, while the model
can call `preview_route` with inputs it selects. The tool returns actual computed
destinations, not hints about the rule. No file, shell, evaluator or held-out
case access is mounted on the explorer. The initial cold input is visible as part
of the failed task; no successful example or correction is supplied in advance.

A cold run first attempts a prediction without retained knowledge. A settled
mismatch starts the experiment. Exploration may preview at most 24 records,
through 12 model iterations and 32,000 tokens; generation is a separate fresh
run receiving the recorded outputs, without the explorer's unverified narrative.
Generation must produce a scoped instructional candidate and its uncertainty.
Model weights and executable kernel code stay fixed.

Verification and fresh confirmation each contain five task groups, two trials
per group, in three arms:

1. Baseline without experiment-derived experience.
2. Full raw observations without synthesized guidance.
3. Generated guidance without the raw observation trace.

Three groups predict destinations; two preserve unrelated document reading and
arithmetic. All arms use fresh histories, the same model, low effort, input-read
tool and per-case limits: eight iterations, 24,000 tokens, 120 seconds. All arms
lack preview access during evaluation. This intentionally measures retained
knowledge of a previously unknown service, not online problem-solving superiority
when every arm can query the answer. Input records, paths and answer values change
between rounds. Arm order rotates, with sequential live runs and no adaptive retries.

The host scores exact output, successful reading of the task input, unchanged
files, normal completion and settled usage. The environment implementation is
the authority for its own behavior; this is a synthetic test, not an externally
validated real service. The scorer remains outside model-editable tools. The
preservation gate must pass before activation. Three additional inputs follow
reopening; explicit rollback removes guidance and repeats those inputs in fresh
sessions. Those holdouts are related variants, not evidence of cross-domain transfer.

## Results

One predeclared live study completed with Muse Spark 1.3 Contributor Free, low
effort: 69 SDK runs, no repeated study or discarded live attempt. The cold run
returned `UNKNOWN`. Muse then selected 16 records in three preview tool calls,
varying kind, sealed status, date and identifier, including a repeated observation.
A separate Muse run synthesized the recorded outputs into guidance. No correct
answer, handwritten correction or candidate was supplied to those live runs.

| Fresh test round | No retained experience | Raw observations | Generated guidance |
|---|---:|---:|---:|
| Verification | 4/10 | 10/10 | 10/10 |
| Confirmation | 4/10 | 10/10 | 10/10 |
| Combined | 8/20 | 20/20 | 20/20 |

The twelve route predictions explain the gain; all eight unrelated protected
checks passed in every arm. The preservation gate accepted the candidate. After
reopening persistent state, three fresh route inputs passed with accepted guidance.
After explicit rollback, three fresh sessions returned `UNKNOWN` on the same
inputs. This supports useful retention of model-acquired experience in this
environment; raw observations achieved the same accuracy as generated guidance.

Reported usage was 281,178 tokens: 256,631 in the learning cycle and 24,547 in
post-cycle reopening/rollback runs. The cycle settled 63 unique receipts, with no
unknown token usage. Prices were unknown for all live receipts; zero-valued cost
fields do not mean these calls were verified free. Across the twenty evaluated
cases per arm, raw observations used 105,302 tokens and generated guidance 65,337.
That is an observed reduction of about 38% at equal accuracy, excluding acquisition
and synthesis costs; one study does not establish a general efficiency advantage.

The original transcripts retain 17 rejected attempts to read outside `input.txt`:
one in the cold run, thirteen in baseline evaluations and three after rollback.
No such read succeeded, and none of these errors occurred during exploration or
guided evaluation. All 69 study runs reached normal completion with settled
usage. These within-run tool errors were retained; they were not removed from
token totals or retried as replacement study runs.

The unedited candidate also contains a wording defect: it describes the kind
token as the third unsealed path segment, although its correct formula puts it
fourth when counting the root. Exact-path tests passed despite this inconsistent
description. Acceptance verifies the tested behavior, not every explanatory
sentence, all possible records or a formally correct world model. No human repair
was applied to the accepted text.

Retained evidence:

- [Live study and independent transcript/storage audit](results/2026-09-14-autonomous-learning-muse.json).
- [Scripted execution control](results/2026-09-14-autonomous-learning-control.json), which is not learning evidence.
- [Initial control failure](results/2026-09-14-autonomous-learning-control-failure.json), corrected before live preparation.
- [Actual TUI frames, approvals and parent runs](results/2026-09-14-autonomous-learning-tui.json).
- [Pinned research source hashes](results/2026-09-14-autonomous-learning-sources.json).
- [Local check summaries and log hashes](results/2026-09-14-autonomous-learning-checks.json).

The built TUI ran in a 120×34 PTY with a separate temporary application home.
Muse started the command once after one exact-command approval, read the running
job without another approval and ended its turn while the experiment continued.
The TUI displayed the job's exit code 0 between turns; `/jobs` confirmed it.
The parent launch turn consumed 32,913 reported tokens.

The requested post-completion summary did **not** pass: its additional parent
turn produced an empty message and one unresolved usage receipt before invoking
any tool. The TUI correctly showed unconfirmed usage, not successful completion
or a claim that zero tokens were consumed. No automatic retry was made. Its
underlying transport/provider cause is not present in the retained transcript;
the SDK's `refusal` message label alone is not proof of a policy refusal. This
remains a separate provider/stream-diagnostics follow-up. Parent usage is therefore
at least 32,913 tokens with one unknown request, separate from the fully settled
281,178-token learning study. `/exit` closed the TUI with exit code 0.

Validation passed: workspace typecheck, lint, build, 11,468 workspace tests,
269 SDK process tests, two environment tests, docs conformance/fences, signature
exports, project references and SDK test presence. Lint retains existing warnings.
The audit independently reopened SQLite, recomputed the acceptance decision,
matched observed outputs to original tool results, checked complete protocol
coverage and usage receipts, and verified withheld inputs were absent from
exploration/generation histories. This is not a full release-gate or publish claim.

## Reproduction

Build the repository first. Preparation performs no inference:

```sh
node research/resident/autonomous-learning-study.mjs --prepare --live
```

Run the exact command it prints in an isolated Namzu TUI, or directly in a terminal.
The TUI can start it once with background Bash, read the job's output and leave
the session open. The experiment invokes the built CLI's `resident learn` with
its own application home. Its declared 1,500,000-token cycle allowance includes
the cold run, exploration, synthesis and all three evaluation arms. Post-cycle
holdouts and parent TUI consumption are recorded separately. All use Muse low;
unknown prices are never reported as a free-service result.

Omit `--live` for scripted controls with real tools/storage. Those scripted probes
and answers verify execution only. The first control found a study-script error
in the rollback API call; its failed record is retained. The corrected control
completed activation, reopening and rollback before live execution began.

```sh
node research/resident/autonomous-learning-study.mjs --inspect /absolute/study/root
node research/resident/autonomous-learning-audit.mjs /absolute/study/root
```

The audit reopens SQLite, recomputes the review, checks generated text against the
model output, matches probes to actual tool calls, checks original run receipts,
recomputes case outcomes and verifies held-out inputs were absent from learner
messages. It never calls a model or repeats the experiment.

Independent discovery, useful retained adaptation, recursive improvement and AGI
require different evidence. This work targets the first two in a small environment.
It does not show that the model improved its own exploration/synthesis procedure,
that arbitrary user conversations are automatically graded, or that learning runs
continuously without an explicitly authorized host.

The next research step should measure the *learner*: let it propose an exploration
or synthesis strategy, then compare that strategy with a frozen one across unseen
environment seeds at the same acquisition budget. Retain unsuccessful proposals,
use a separate confirmation set and require a higher subsequent improvement yield
before activation. This study implements the evidence-acquisition stage needed
for that comparison; it has not yet implemented or demonstrated recursive changes
to the improvement procedure.
