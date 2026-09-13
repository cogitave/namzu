# Resident evidence selection under competing subjects

Measured on 2026-09-13. Baseline: `97acc32c`. This follows
[automatic original-tool recall](automatic-recall.md). It evaluates what reaches
preparation and real provider requests separately from what a model concludes.

## Reproduced failures and primary sources

The baseline selected at most 16 words from the last 4,000 characters of each
admitted field, then traversed four source pages. Long release-review notes
could discard the original subject at the beginning; even a shorter accepted
correction could lose its subject at the end of a wordy input. Separately,
frequent matching observations could consume every candidate page before a
rarer requested observation was discovered. BM25 cannot rank an unseen record.

The pinned [Pydantic AI Harness source](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py)
was inspected locally at that exact commit and on GitHub: its conversation
search filters authorized runs, materializes their full index text and ranks
before display truncation. Namzu retains its bounded I/O contract. This is an
implementation comparison, not a runtime benchmark against Pydantic AI.

The [xQuAD primary paper](https://archives.iw3c2.org/www2010/publications/santos10pdf.pdf)
motivates covering information needs not represented by already selected
results. Here the existing `refineEvidenceRecallTerms` helper measures only
literal token coverage. Words are not semantic aspects; this is not xQuAD,
probabilistic intent inference, or an approximation-quality claim.

## Measured SDK cases

[selection-quality.mjs](selection-quality.mjs) runs the actual SDK preparation
adapter and renderer against a deterministic **simulated paged source**. It
separately records discovery, quoted text, queries, page count and character
count. Its charged-byte figures are simulated accounting, not disk measurements.
Long cases use [multi-subject review notes](review-notes.mjs), not a live user's
data. The baseline helper transpiles the committed adapter and shared engine
into a temporary directory without replacing installed build output.

| Case | Expected original observations quoted: baseline | Candidate |
| --- | ---: | ---: |
| Several named subjects | 3/3 | 3/3 |
| Frequent observations before rare subjects | 0/2 | 2/2 |
| Subject at the beginning of a long summary | 0/1 | 1/1 |
| Subject at the beginning of a long objective | 0/1 | 1/1 |
| Accepted correction at the end of a wordy input | 0/2 | 2/2 |
| Ambiguous reference to two receipts | 2/2 | 2/2 |

All cases stay within four pages and 6,000 added characters. No planner or
answer-model call is involved. The ambiguous case retains both subjects without
choosing which one the operator meant; whether a live model asks the right
clarification is **not measured** by this fixture. These six deliberately chosen
cases are regression evidence, not a representative benchmark success rate.

```bash
node research/resident/selection-baseline.mjs /tmp/namzu-selection-baseline.json
node research/resident/selection-quality.mjs candidate /tmp/namzu-selection-candidate.json --verify
```

## Real CLI discovery failure and correction

The process driver uses the actual CLI resident composition and real read tools
to record 20 regional inspection notes before an oversized original receipt.
The latter contains fresh random tracking/destination identifiers beyond the
retained preview. A scripted seed stores no identifier in its summary, then
replaces the workspace file. Recovery happens in a separate admitted Session.

Baseline preparation omitted both identifiers from the actual first provider
request. A first candidate using a fresh subset search also missed them:
empty index-progress pages consumed capacity before the focused scan reached
the original receipt. This failed candidate is retained in the experiment
record; passing the simulated source was insufficient.

The final design branches a strict subset at the authenticated broad cursor,
avoiding a restart of already visited index pages. The broad cursor is preserved.
SDK validation checks the original token membership, case mode, filters and scope
before binding a future cursor to the subset. Unsupported custom backends use a
fresh subset search; no position is guessed. Both scans share the original page,
candidate, byte, deadline and context allowances.

| Trial | Both identifiers in first request | Model requests | Recovery tools | Reported tokens |
| --- | --- | ---: | ---: | ---: |
| Baseline, scripted | No | 1 | 0 | 0 |
| Fresh-subset candidate, scripted diagnostic | No | 1 | 0 | 0 |
| Cursor-subset candidate, scripted | Yes | 1 | 0 | 0 |
| Cursor-subset candidate, Luna/low | Yes | 2 | 1 | 14,850 |

The live tool was `read_resident_tool`; the final answer contained both exact
identifiers. It did not reread the mutable file or execute the original action.
Its two Sessions had confirmed cleanup and a further run admitted no work.
The live invocation used `codex/gpt-5.6-luna`, effort `low`, eight iterations
and a 40,000-token per-step ceiling. Subscription usage is **unpriced**, not
claimed free. All scripted trials and the initial seed-driver assertion failure
reported zero provider tokens. Build fingerprints were stable during each run.

The live trial preceded subsequent validation-room, Unicode-boundary and
unstarted-scan hint checks. These leave the output allowance unchanged and are
covered by dedicated regressions. The final scripted process
check covers the completed build; this distinction is recorded with fingerprints.

```bash
node research/resident/tool-evidence-cli.mjs --scripted --automatic --distractors
node research/resident/tool-evidence-cli.mjs --live --automatic --distractors
```

The baseline-only `--expect-miss` flag asserts an actual omission and a blocked
scripted result; it is not a success criterion for the candidate implementation.
Failed provider assertions retain claims and usage ledgers rather than silently
restarting the run.

## Multiple admissions and invariants

The CLI integration test runs three real resident Session admissions, both with
short state and with a long objective/summary plus a late accepted correction.
The first reads the original, the second reads the edited document, and the
third receives both archived observations after both have disappeared from the
workspace. The provider request contains their separate historical Session,
revision and claim addresses. A deliberately unverified summary identifier does
not become an original-tool quote. These are scripted provider tests, not model
judgement scores.

Tests also cover scope mismatch on a focused page, unchanged ordinary-chat
authority, exact subset membership, preserved filters, broad and focused cursor
reopening, read allowances, foreign/malformed results, unavailable archives,
cancellation, pending reads and oversized continuation omission. A process test
branches a token cursor in another process and still reuses the original cursor.

## Limits

The middle of a field longer than 4,000 characters can still be omitted. The
16-term allowance is not a semantic planner. A frequent uncovered word can fill
the subset pages, and a source can exhaust the byte/deadline allowance before
the relevant record. Sparse pages deliberately continue broadly so later
corrections of the same subject are not displaced merely by unused query words.
Ranking may omit an observed passage when context space is tight. Continuations
which do not fit are counted as omitted; they are not proof of exhaustive search.
No observation's truth, current validity or referent is established by selection.

[Recorded results](selection-quality-results.json) preserve the dataset identity,
baseline source identity, request observations, build fingerprints and failed
trials. Workspace tests passed: **6,761 SDK**, **3,022 CLI** (five existing skips)
and the other packages, retaining their existing optional provider skips.
**265 SDK process tests** passed, including cross-process subset branching.
Typecheck, workspace build, lint, docs/fences, signature exports, SDK test
presence, project references and workflow parity passed. Lint retains existing
warnings. No push, publish or complete release-gate run is claimed.

## Completion audit

The original objective remains broader than any one retrieval fixture. For this
selection milestone, the evidence is:

- Baseline implementation and pinned primary sources were inspected before
  choosing changes; the same dataset runs against the committed baseline and
  candidate adapters, with source and dataset hashes.
- Multiple subjects, accepted corrections, long state, crowded rare observations
  and an ambiguous referent are all represented. Discovery and quoted context
  are measured separately. No scripted response is credited as model judgement.
- The real CLI reproduces the miss and the failed fresh-subset candidate, then
  verifies the final cursor-subset path. One bounded live Luna/low trial checks
  the actual answer and bills all reported tokens; all failed controls remain
  recorded. Three-admission tests inspect actual request contents and receipts.
- Authority and provenance remain validated on every returned page; focused
  scope failures, subset/filter checks, original-cursor reuse, byte/page/context
  bounds, Unicode cuts, cancellation and pending reads have regression coverage.
- SDK public options, CLI behavior, limitations and bump intent are documented.
  This does not establish semantic referent resolution, universal retrieval
  recall or completion of the wider autonomous-kernel vision.
