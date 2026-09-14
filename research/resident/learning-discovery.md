# Learning discovery: retained failure to one evaluated experiment

This milestone adds experiment selection to the existing SDK learning cycle. It
is a step toward continuous improvement, not evidence of AGI or recursive
improvement of the improvement algorithm itself.

## Research and implementation decision

[GEPA](https://arxiv.org/abs/2507.19457) uses execution feedback to propose revised
instructions. Its
[reflective proposer](https://github.com/gepa-ai/gepa/blob/15ee314f9c7d34ec153b809d401f42f55c4dcd76/src/gepa/proposer/reflective_mutation/reflective_mutation.py)
deduplicates parent evaluation, constructs reflective datasets and returns
candidates to an engine that owns acceptance. The inspected source snapshot is
retained under `/tmp/namzu-rsi-source-mwat4b0y/gepa`. Namzu already separated
proposal from acceptance, but required the host to supply one hand-selected
failure. This milestone fills that input-selection gap; it does not reproduce
GEPA's Pareto optimizer or claim its published scores.

[Hyperagents](https://arxiv.org/html/2603.19461v1) distinguishes improving a task
agent from improving the procedure that generates future agents. Its
[initial parent selector](https://github.com/facebookresearch/HyperAgents/blob/59a68f672dfb92c74aeb7e61535d776fb36e172d/select_next_parent.py)
uses an archive of eligible evaluated parents and initially selects randomly.
Namzu currently selects an old eligible failure using FIFO fairness. That choice
is an explicit engineering policy; it is not an optimal-learning theorem or a
learned metacognitive strategy. A later research step would compare alternative
selection/proposal procedures by improvement yield on independent tasks under
matched total resource use.

The concrete conclusions from this comparison are:

- Keep failures, successes and execution failures distinct. Unknown receipts
  must not create a false learning signal.
- Bind observations to a task/input revision, installed guidance and host-owned
  evaluator/execution conditions. Old evidence is not automatically current.
- Retain selection and admission atomically, so a crash or repeated request does
  not consume another experiment on the same task.
- Generate from retained evidence, then use independent evaluation and fresh
  confirmation. A proposal's explanation is not its own acceptance criterion.

These are our engineering inferences from the research and the earlier Namzu
experiments. No upstream benchmark was rerun.

## Scope

The SDK exposes `SqliteResidentLearningStore.observe`, `observations`,
`selectObservation` and `runStoredResidentLearningFromObservations`. The CLI's
explicit executable learning host can opt in with evaluator revisions and inspect
observations through `resident learning --observations`.

This feature does not automatically grade arbitrary user conversations, create a
new daemon, change subscription model weights, or let generated text rewrite the
acceptance evaluator. Hosts authenticate observations and authorize experiments.
The existing resident executor and cycle retain their ownership boundaries.

## Evaluation protocol

`learning-discovery-study.mjs` imports one genuine retained Muse failure from
`/tmp/namzu-tool-learning-3J6rt8`: run
`59f6e99b-59d6-40ed-b85b-8d708453980a` completed with `retired-seed` instead of the
current source's `active-seed-v0`. Its usage was settled (9,408 tokens). This is
historical generation evidence, not a newly measured cold run. Its original
source value and usage receipt fields are checked before import.

The host also supplies the authoritative correction from that study. Thus the
experiment measures learning from a retained failure **and a host correction**;
it does not show spontaneous discovery of an unknown rule. Only the failure
trace and correction reach generation; fresh evaluation inputs are separate.

The predeclared new study uses:

- Zen `muse-spark-1.3-contributor-free`, low effort, one candidate, no adaptive retries.
- Built CLI `resident learn`, isolated home and fresh file fixtures.
- Five task families, two trials per family and arm. Verification and
  confirmation have distinct task IDs, paths and answer values.
- Existing baseline versus generated guidance. Each case has a fresh SDK run,
  read/glob/grep tools, 24,000-token budget, eight iterations, 120-second deadline.
- Sequential model calls; confirmation reverses arm order. No other live model
  exercise runs concurrently. This is not a latency benchmark; local tests may
  run concurrently.
- A 12,000-token generation budget and the existing 800,000-token cycle allowance.
- Success requires the exact value, a successful read/search result from the
  current source, and normal completion. Interrupted or unsupported outputs fail.
- Every run and usage receipt is retained. Unknown usage prevents activation.
- A second invocation must create no new model call after the task is claimed.

The default scripted control uses real file tools and SQLite with fixed model
outputs. It tests selection, verification, confirmation, activation and reopening;
its score is not empirical model improvement.

## Results

The [live audit](results/2026-09-14-learning-discovery-muse.json) independently
recomputed all recorded scores from successful tool outputs. Study directory:
`/tmp/namzu-learning-discovery-iys9DN`.

| Stage | Existing baseline | Generated guidance |
| --- | --- | --- |
| Verification: five families × two trials | 6/10 | 10/10 |
| Fresh confirmation: five families × two trials | 7/10 | 10/10 |

The existing reviewer accepted both batches and activated candidate
`workspace-source-selection` in cycle `aa433b22-2b28-4cd8-a27f-1f6ccdb176f6`.
One generation plus forty evaluated runs consumed **383,133 recorded tokens**.
All receipts settled; every price was unknown, so this is not a dollar-cost
measurement. The historical seed's 9,408 tokens are separate and were not spent
again. Some baseline runs ended at their declared iteration bound; they remain
failed trials rather than being dropped or retried.

A second built-CLI invocation selected no work and made **zero new model calls**.
The installed guidance and the observation's experiment reference survived
reopening. The [scripted control](results/2026-09-14-learning-discovery-control.json)
also passed selection, both evaluations, activation and replay suppression; its
40/40 guided outcomes come from scripted responses, not measured model learning.

This is a small positive result on one source-selection family. Two trials in a
family are correlated evidence, not twenty independent task domains. It does not
establish improvement on ordinary coding work, alternate models, other evaluation
contracts, or the method that selects and generates future improvements.

## Actual TUI inspection and resulting fix

The [terminal receipt](results/2026-09-14-learning-discovery-tui.json) records two
real 120×34 PTY conversations using the built CLI and Muse low. Both asked:

> Bu klasördeki resident hangi hatadan öğrenmiş, deney sonucu ne? Kayıtlarından kontrol et. Yeni deney başlatma veya dosya değiştirme; sonucu kısa anlat.

The initial preview exposed status and artifact identities but omitted the
failure reason and paired scores. The model executed three read-only Bash calls,
then proposed another help call. The tester interrupted at that fourth approval;
the cancelled run is preserved, not counted as a completed answer.

The CLI preview was updated to include a bounded observation reason and exact
verification/confirmation pass counts from the retained review. The same question
in a new conversation then completed with **one read-only tool call**, explaining
the retired-source error and both score improvements. No new experiment or file
edit was performed. These are two observed interactions, not a statistically
controlled efficiency benchmark. The fixture's `AGENTS.md` names the inspection
commands but contains no scores or answer text.

The two TUI runs recorded 56,469 and 21,990 tokens respectively. They occurred
after the isolated learning experiment. Both PTYs exited cleanly. The fixture's
restricted PATH caused an unrelated computer-use availability warning because
Windows PowerShell was absent from that PATH; this did not test desktop use.

## Local checks

Workspace typecheck, lint, build and tests passed: **6,884 SDK tests** and
**3,118 CLI tests** (five CLI skips). Three process tests covered SQLite
contention/interruption, including two independent processes claiming one task.
Docs OKF, compiled fences, exported-signature checks and SDK test presence passed.
After the TUI-driven preview change, CLI typecheck/build/lint and its eight
learning-command tests passed again. The evidence scorer's four tests also passed.
Full publish/coverage/consumer gates were not rerun; this is a local implementation
milestone, not a published release.
