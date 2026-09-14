# Learned guidance across task boundaries

The previous source-selection study established a gain inside one narrow task
family. It did not establish that its accepted guidance belonged in every later
resident request. This diagnostic keeps that exact accepted candidate fixed:
`dcfd9b331994021ba72c40c71d01dec44ec81954766c812a2df70800a8a21103`.
No guidance generation, tuning, promotion, rollback or model-weight update occurs.

## Sources and design

[When Continual Learning Moves to Memory](https://arxiv.org/html/2604.27003v1)
separates reuse within a task from transfer to another task, and measures
interference through retrieval. Its experiments concern ALFWorld and BabyAI;
its results are not Namzu scores. We adopt the need for a fixed-memory comparison
on different tasks, not its experimental implementation or numerical claims.

[Pydantic AI Harness Skills](https://pydantic.dev/docs/ai/harness/skills/)
provides on-demand skill loading. OpenAI's public
[skill-authoring instructions](https://github.com/openai/skills/blob/main/skills/.system/skill-creator/SKILL.md)
describe metadata before full instructions. Namzu already has a comparable
filesystem/plugin `skill` tool in `packages/sdk/src/tools/builtins/skill.ts`.
The missing boundary was its **evaluated resident learning**, whose bodies were
automatically included independently of task applicability. SQLite resident
guidance is not a filesystem skill or a plugin installation; the new access path
retains its source-revision checks and admitted-run ownership.

## Fixed-candidate diagnostic

`learning-transfer-study.mjs --live` runs Muse Spark 1.3 Contributor Free at low
effort, sequentially, on eight fresh isolated fixtures: two each for a document,
configuration precedence, CSV aggregation and an append that must preserve a
manual note and an unrelated file. Each case has baseline and eager-guidance
arms; arm order alternates. Inputs and scoring are saved before the first call.

All attempts count, including unfinished ones. Passing requires a settled usage
receipt, `end_turn`, the exact requested answer, a successful read of the named
source and an exact final file manifest. The host checks final files rather than
trusting a model's claim that it preserved them. Limits are eight iterations,
24,000 cumulative tokens and 120 seconds per trial; these explicit research
limits do not change unlimited CLI defaults.

| Arm | Passed | Tool calls | Failed tools | Recorded tokens |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 8/8 | 19 | 0 | 68,883 |
| Eager prior guidance | 7/8 | 34 | 9 | 108,572 |

All receipts settled; provider prices were unavailable. In the failed document
trial, a directly named document could have answered the question, but the model
searched for the source map prescribed by the unrelated guidance and stopped at
the experiment's token allowance. This is an observed failure and overhead
diagnostic, not a population estimate from eight small fixtures.

## On-demand implementation and follow-up

The SDK's `createResidentStepContext` returns a short catalogue, an admitted-run
`read_resident_skill` tool, and per-request context for selected bodies. Nothing
loads simply because it was accepted by an earlier experiment. The model decides
relevance; the host still owns authorization, source freshness and task grading.
Descriptions are optional guidance advertisements, not instructions to execute.
Changed dependencies withhold selected guidance with a notice; old tool results
remain historical, rather than being silently deleted from the transcript.

The existing eager SDK factory remains available. CLI residents select on-demand
disclosure by default and support `--learning-disclosure eager` for comparison.

The second study uses `--live --disclosure`: four fresh unrelated tasks and two
source-map tasks, with baseline/eager/on-demand arms in rotating order. Unlike
the initial direct-instruction diagnostic, all three arms use the real resident
prompt contributions and `drainQuery`. This isolates disclosure under the actual
resident policy, including whether a useful skill is still retrieved. Differences
between the two study protocols prohibit treating their scores as one paired set.

Recompute either record from retained evidence with
`node research/resident/learning-transfer-audit.mjs <study-root> [output.json]`.
The default non-live study uses scripted model turns and real tools: it checks
integration and scoring, and is not evidence of model learning or transfer.


### Follow-up results

| Arm | Correct, settled completions | Unresolved attempts | Tool calls | Failed tools | Recorded tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baseline | 4/6 | 0 | 19 | 0 | 74,418 |
| Eager | 6/6 | 0 | 18 | 2 | 79,861 |
| On-demand | 5/6 | 1 | 17 | 0 | 75,282 |

The on-demand document attempt failed before receiving output with `zen — could
not reach the provider: The model stream failed.` Its receipt remains poisoned
with one unresolved request. The zero recorded tokens for that attempt are not
zero actual usage; the totals therefore cannot establish a token-saving rate.
It was not repeated or dropped. The other five on-demand trials completed with
correct answers and exact preserved files. Both source-map cases loaded the
skill and passed; both baseline cases returned retired values. The three
completed unrelated on-demand tasks did not load the skill. Eager has the best
all-attempt completion count in this small follow-up, so this is not a claim
that on-demand beats eager across every workload.

Records: [initial diagnostic](results/2026-09-14-learning-transfer-before.json),
[resident disclosure comparison](results/2026-09-14-learning-disclosure-muse.json).
The accepted skill's original full verification metadata was added to the prior
result artifact to make this fixed-candidate study reproducible; its body,
hash, evaluation, activation and scores were not changed.

After the follow-up started, metadata display was capped at 160 rather than 240
code points, control characters were normalized, and selected context was made
to share the original profile's 12,000-character budget. The candidate's short
ASCII description and empty profile in the comparison are unaffected. Final
unit and TUI checks exercise those final bounds; the comparison is not a test
of long descriptions or a full profile.

### Actual TUI check

In an isolated 120×34 terminal, the built CLI used Muse low for two ordinary
parent turns. Each requested one prepared resident step and received one Bash
approval. The default on-demand resident profile was used; no learning experiment
ran. Both parent turns and both resident runs ended with settled receipts:
157,109 total recorded tokens. The document result was `Deniz`, and the source
result was `active-tui`. Both objectives settled complete.

The document run nevertheless widened its inspection and loaded the broadly
described source-selection skill. It made ten tool calls, including an attempted
shell call refused under read-only permissions. The source run used the skill
and its source files. This live counterexample limits the claim: catalogue
disclosure gives the model control over relevance; it does not enforce relevance.
The fixture's project instructions also explained the CLI launcher to the parent
and were inherited by the resident. This is a real TUI integration check, not a
controlled before/after exploration-efficiency experiment.

The [TUI record](results/2026-09-14-learning-disclosure-tui.json) retains all four
run identifiers, tool calls/results, usage and terminal/transcript digests. All
processes exited. The fixture's restricted PATH produced an unrelated
PowerShell/computer-use availability notice; desktop control was not tested.

Follow-up: the [preservation-gate experiment](learning-protection.md) now requires
protected tasks from other families **before** activation. A short learned description and an instruction
to skip irrelevant skills do not replace those negative controls. Scope-aware
learning admission and robust transfer remain unfinished; this is not RSI or AGI.

### Validation

Workspace type checking, lint, build and all package tests passed (6,890 SDK;
3,120 CLI with five existing skips). Focused tests cover metadata-only admission,
complete disclosure, mutable source invalidation, unavailable observations,
context bounds, cancellation and rejection of foreign/settled runs. The real CLI
session test checks deferred schema loading, read-only execution and isolation
from the next ordinary send. Docs OKF, TypeScript fences, exported signatures and
SDK test presence passed. Release coverage and consumer-install gates were not
run; no publish or push is implied.
