# Resident follow-ups: subject, observation time and current evidence

Measured on 2026-09-13 against `2bcf017f`. This follows the
[selection experiment](selection-quality.md), which retained both possible
subjects but did not evaluate a live answer to an ambiguous reference.

## What failed before changing code

Five actual CLI runs used `codex/gpt-5.6-luna`, effort `low`. Every first
provider request contained the two original, successful tool observations from
separate settled admissions. Both subjects and their original/corrected values
were present. The third, current document had not entered that context.

Despite this successful delivery, the model selected Cedar for an unnamed
reference, treated a historical correction as current on “And now?”, and
correctly resolved an accepted subject correction to Juniper while still
reporting its historical value as current. These are interpretation failures,
not an absence of the necessary historical observations.

The missing-current-file case was mixed: the model used `glob`, reported the
file missing, and qualified its answer as historical, but nevertheless marked
the current-state review complete. It was not an unqualified fabrication of
file contents. The original-observation case answered correctly, including a
clearly labelled comparison with the later record.

## Sources inspected and design choice

The SDK's [`evidence-query.ts`](../../packages/sdk/src/run/evidence-query.ts)
already has an optional conversation query planner with subject/time decisions,
grounded token IDs, exact quoted references, ambiguity handling and bounded
input/inference. It requires preceding operator or marked summary context.
A resident admission has its own scoped, structured objective/summary/wake
snapshot and a fresh conversation. Turning on that conversation planner would
not by itself supply this different reference history.

The pinned [Pydantic AI Harness implementation](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py)
was inspected locally at the linked commit, including its search description,
scope filtering and `_load_sections` implementation. It ranks archived messages
using BM25 and leaves question interpretation to the consuming agent. It does
not make a relevance score a temporal or referential verdict. This is a source
comparison, not a live benchmark of Pydantic AI or a claim about every backend.

[LongMemEval](https://arxiv.org/abs/2410.10813v2) separates retrieval from reading
and evaluates temporal reasoning, updates and abstention across sessions.
[AmbigQA](https://arxiv.org/abs/2004.10645v2) treats multiple plausible
interpretations as distinct alternatives. These motivate separating observed
context delivery from answer judgement here. We did not run either benchmark,
copy their datasets, implement their complete methods, or reproduce their scores.

The production change is confined to the SDK's
[`createResidentStepContributions`](../../packages/sdk/src/prompt/resident-step.ts)
guidance. It asks the model to establish subject and requested time separately:

- An accepted correction can identify the subject without rewriting an earlier
  observation.
- An unnamed reference with competing subjects needs labelled alternatives or
  clarification; retrieval order and summary mention cannot select the referent.
- A current-state question needs a fresh permitted observation. The most recent
  archived receipt only establishes what was last observed.
- If fresh evidence is unavailable, state the limitation and leave the
  current-state task unfinished. Historical answers still use historical receipts.

No extra planning call, lexical classifier, new persistent state, broader archive
access or forced replay was added. The stable guidance grows by 1,059 characters.
It remains model guidance, not an enforcement mechanism or semantic verifier.
The CLI's default `resident` context profile uses it; the opt-in `interactive`
profile's older host prompt is not changed by this patch.

## Reproducible experiment

[`interpretation-cases.mjs`](interpretation-cases.mjs) defines synthetic records,
two saved summaries, an accepted correction and follow-up inputs. The objective
names both Cedar and Juniper. The summaries contain neither routing code and do
not nominate one subject. Only the document fixtures contain the values:

| Source state | Cedar | Juniper |
| --- | --- | --- |
| First observed document | CD-1472 | JP-6381 |
| Corrected document, observed in the next admission | CD-2859 | JP-7406 |
| Current document, changed after that settlement | CD-3964 | JP-8527 |

Each case creates an isolated `NAMZU_HOME` and workspace. Two scripted provider
admissions use the actual CLI resident callback, ordinary read tool, durable
agenda settlement and start/finish receipts. They do not fabricate archived
tool results or claim to evaluate model behaviour. After the second settlement,
the driver changes the file again, or removes it from the workspace. The final
admission runs through the actual CLI executable in a separate process with
the live provider. Accepted follow-up inputs are committed before that admission;
this experiment does not simulate live steering during one invocation.

The request observer forwards the real provider call unchanged. It records the
actual selected evidence, continuation snapshot, operator/tool messages and
reported usage. It does not serialize credentials, transport headers, provider
instances or private reasoning. Seed summaries and answer expectations are
separate; the expected answer is never supplied to the model. Production module
fingerprints must match before and after each study run. The only differing
module between the paired live runs is `sdk/dist/prompt/resident-step.js`.

Run from the repository root after building:

```bash
# No live model: validate actual CLI sessions, evidence and receipt contracts.
node research/resident/interpretation-cli.mjs --scripted

# Repeat with committed baseline guidance, without modifying dist.
node research/resident/interpretation-baseline.mjs --scripted

# Paid/subscription inference: five original cases, one bounded invocation each.
node research/resident/interpretation-baseline.mjs --live
node research/resident/interpretation-cli.mjs --live

# Two Turkish follow-ups introduced after selecting the candidate wording.
node research/resident/interpretation-cli.mjs --live --held-out

# Validate committed evidence/ownership/usage independently of driver pass flags.
node research/resident/interpretation-audit.mjs research/resident/interpretation-results.json
node --test research/resident/interpretation-audit.test.mjs
```

`--case=implicit-current` selects one case. `--held-out` selects only the two
additional Turkish cases; default execution retains the original five. The
baseline helper transpiles the pinned SDK source and uses a process-local Node
module hook for CLI/seed subprocesses. Other modules remain the current build;
the manifest records that limitation and both original/loaded source hashes.
The initial paired baseline was run before the production edit, not through
this helper. A later zero-token control verifies the helper and scoped delivery.

Each live admission is bounded to eight iterations, 40,000 reported tokens and
a 180-second process deadline. Failures retain receipts, usage and unresolved
claims; the driver does not restart or reconcile them. These settings are
experiment limits, not changed product defaults.

## Observed answers

Verdicts below are assistant review of the actual answer, accepted inputs and
tool outcomes. They are not scores from an independent judge model. Exact
answers and requests are retained in
[`interpretation-results.json`](interpretation-results.json).

| Follow-up | Baseline | Updated SDK guidance |
| --- | --- | --- |
| Explicit original Cedar code | Correct original value | Correct original value |
| Cedar focus followed by “And now?” | Stale corrected value, no fresh read | Fresh read, current value |
| Unnamed “its” original code | Selected Cedar without a basis | Explicit ambiguity and both labelled originals |
| Correction to Juniper; initial and current | Correct subject and original, stale current | Correct subject, original and freshly read current |
| Juniper “And now?”, current file missing | Qualified historical answer but marked complete | ENOENT read; current explicitly unknown; blocked |

The two later Turkish probes also behaved as required: a request for today's
Juniper entry caused a successful fresh read; an unnamed “bunun” question
returned both labelled original codes without selecting one subject. The latter
did not explicitly ask a clarification question. These are additional candidate
observations, not a paired before/after comparison or a statistically held-out
benchmark.

Both versions mentioned a later value as a labelled contrast in the
explicit-original answer. The driver's `forbiddenIdsAbsent` diagnostic is false
there, but the answer is correct. Similarly, `freshReadAttempted` only counts the
read tool: the baseline missing-file case made a useful `glob` observation.
Substring presence and a tool-name flag are not semantic verdicts.

## Usage and invariant audit

- Baseline: five live admissions, **35,707** reported tokens.
- Candidate on the same five cases: **49,086** reported tokens.
- Two later Turkish probes: **18,454** reported tokens.
- Three scripted study runs (five initial controls, one baseline-loader control,
  five final controls): **0** reported provider tokens.
- Total: **103,247** reported tokens across twelve live admissions. No failed
  live attempt is omitted. Subscription inference is not labelled free and no
  monetary cost is inferred when the ledger has none.

The paired candidate spends more tokens: two stale-answer failures now require
a fresh read and a second model response. Historical and ambiguous cases need
no new read. This is a measured correctness/cost tradeoff, not a cost-saving claim.

The independent audit checks actual request excerpts against the original
successful read text, Session/run/pursuit/revision/claim receipts, three distinct
admissions per case, accepted wake order, the captured history boundary, full
retention and error flags. Each request stays under the existing 6,000-character
automatic evidence limit, 16 query terms and 8 MiB charged-document allowance.
The third content is absent from every first request. Answer tools perform
only reads/searches; no effects are replayed to recover old data. The production
change does not alter the source, candidate, page, cursor, cancellation or
tenant/project authority paths. Existing regressions cover those boundaries.

Validation passed: workspace typecheck, lint and build; **6,761 SDK tests**,
**3,022 CLI tests** and the remaining workspace packages; **265 SDK process
tests**; docs conformance and compiled fences; signature exports, SDK test
presence, project references and workflow parity. Existing skips and lint
warnings remain. The 134 focused SDK tests cover resident context delivery,
recall ownership and budgets plus ordinary conversation recall. The independent
research auditor's **11 tests** reject altered provenance, reordered corrections,
leaked current values, excessive read accounting, omitted usage and builds
changed during a run. This audit validates recorded evidence, not answer semantics.
No push, publish or complete release-gate run is claimed.

The bounded milestone's requirements are supported by separate evidence:
the inspected SDK and pinned source establish the architectural comparison;
the unchanged five-case dataset and before/after module hashes establish the
baseline boundary; actual request blocks establish original evidence delivery;
live answers and tool results establish the particular interpretation outcomes;
the scope/budget audit and existing regressions establish the retained guardrails.
Two additional language probes and all scripted controls remain separately
labelled. None of these evidence types substitutes for the others.

## Limits and next boundary

There is one live observation per case/version. Model sampling, provider
caching and service behaviour are not controlled, so this does not establish a
general error rate or reliable interpretation of every language or reference.
The documents are small and the relevant history fits in context. Long-history
retrieval is covered by separate selection studies, not proven by these answers.
There is no test here of live steering, concurrent residents, autonomous
learning, an unavailable provider, or independent semantic answer validation.

More words in a prompt cannot prove that every future answer will comply.
Host-enforced freshness receipts and structured answer validation remain useful
future research when a task has machine-checkable acceptance criteria. This
milestone demonstrates and addresses particular resident interpretation errors;
it does not complete Namzu's wider continuous autonomous-kernel vision.
