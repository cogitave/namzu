# Exploration-policy comparison with an alternative model

2026-09-14. The operator authorized a model other than Muse after its sustained
HTTP 429 failures. This is a separate experiment, not a continuation or repair of
the [cancelled Muse comparison](exploration-policy.md).

## Model admission and real tool use

The live Zen catalogue listed MiMo-V2.5 Free and Nemotron 3.5 Lightning Free,
consistent with [Zen's published routes](https://opencode.ai/docs/zen/). MiMo's
small request returned HTTP 429. Nemotron's stream ended with a network error
after 120 seconds. No tokens were returned for Nemotron, but its receipt is
unresolved; this does not establish zero usage. Both outcomes are retained in the
[availability checks](results/2026-09-14-exploration-policy-alternative-models.json).

The MiMo probe mistakenly passed its tool to the registry constructor instead of
registering it. It therefore only establishes a rejected request, not a tested
tool interface. Subsequent probes explicitly registered the tool. The installed
Codex catalogue exposed GPT-5.6 Terra; its low-effort probe called `probe_status`
once and returned `ready`, with a settled 274-token receipt. It used the existing
subscription route, without changing the user's credentials or preferences.
Luna and large-model fallbacks were not used.

## Fixed comparison

The prepared study fixes `provider: codex`, `model: gpt-5.6-terra`, `effort: low`,
its environments, protection tasks, source hashes and acquisition limits before
generation. It uses the same five rule families and paired resource allowances
as the original study, with independently seeded environments. All proposal,
exploration and prediction requests use that selection. The policy remains
model-generated and unchanged by the operator. The audit checks the provider and
model in original SDK run metadata, effort, paired condition hashes, tool
observations, completeness and every cycle receipt.

The SDK's run deadline is checked between iterations; the Nemotron availability
probe showed that this alone did not stop its pending stream at the requested
45 seconds. The research driver now additionally supplies a per-run deadline
signal. A controlled pending stream test verifies interruption and no later
episode. This is a research-host correction, not a claim that all kernel deadlines
have been changed.

The [alternative-selection scripted control](results/2026-09-14-exploration-policy-terra-controls.json) passed both evaluation rounds and
verified explicit projection, reopened execution and rollback. It contains no
learned result. [Four standalone environment/driver tests](results/2026-09-14-exploration-policy-terra-checks.json) passed, including the
provider-error and in-flight deadline paths. Production package source was not
changed in this follow-up; the earlier workspace gates belong to commit `3e090246`.

## Live TUI observation

The built Namzu TUI ran in a separate home in a 120×34 PTY. Terra requested one
background command and received exact approval. It then polled empty job output
repeatedly, listed the job and requested `sleep 30`. The waiting prompt contributed
to that behavior; the tool reads themselves were immediate. The test driver
attempted steering while the approval overlay was active, then its Enter approved
the sleep. A subsequent explicit steering message ended the parent turn while
the existing job continued. This is not a claim that the initial interaction was
efficient or that the first steering message reached the model.

The parent never received hidden environment records or evaluator answers.
Its waiting/tool activity is tracked separately from the scored child runs:
124,629 tokens, two bash calls and ten job observations. That waiting overhead
exceeded the entire learning experiment's 108,889 tokens. Existing background
completion notifications worked after the parent ended its turn; they did not
require this polling. This remains an efficiency issue exposed by the TUI test,
not a resolved feature of the learning-policy change.

The exit notification appeared between turns. `/jobs` then showed exit 0 without
another model request. The test closed the TUI normally with `/exit`; the owned
parent process exited 0. [TUI frames and event evidence](results/2026-09-14-exploration-policy-terra-tui.json)
retain the distinction between process completion and the rejected learning cycle.

## Result

The [independent audit](results/2026-09-14-exploration-policy-terra.json) verified
all ten complete pairs, forty-one settled model runs and their original transcripts.
There were no provider failures or unknown token receipts in this experiment.
The cycle ended **rejected**. No exploration policy was activated.

| Measure | Frozen policy | Proposed policy |
| --- | ---: | ---: |
| Completely correct episodes | 8/10 | 5/10 |
| Correct individual predictions | 48/60 | 50/60 |
| Preview records | 80 | 80 |
| Exploration plus prediction tokens | 36,724 | 68,950 |

The proposal added 3,215 tokens outside the paired arms, for 108,889 study tokens.
The proposed arm consumed 87.8% more tokens. All forty-one price receipts were
unknown; the stored zero cost is not a claim of free inference or a verified
subscription charge. The availability probes and TUI parent are separate usage.

The slight increase in aggregate correct predictions hides regressions in the
month, day and year tasks. In the first month episode, the proposed procedure
spent its eight observations without ever testing the `notice` category, leaving
two destinations unknown. It did improve the identity task's observed complete
passes from one to two. That does not offset the other regressions under the
predeclared acceptance rule. The identity preservation control was also not proven:
the baseline itself passed only one of its two trials. The audit retains that
uncertainty rather than relabelling the control after seeing results.

The existing gate rejected the candidate before confirmation, as required by the
predeclared protocol. It did not spend fresh confirmation or holdout calls on a
rejected candidate, and there was no accepted live policy to reopen or roll back.
The positive persistence/rollback path is covered by the explicitly scripted
control, not by a falsely activated real policy. No replacement proposal or
successful substitute sample was generated.

This is a completed negative comparison, not evidence of improved learning or RSI.
It establishes that another installed provider can run the experiment and that a
model's more elaborate procedure can be measured, retained and refused. The next
learning question is how the proposer learns from such rejected trajectories;
this experiment does not answer it by silently rewriting the policy for the model.
