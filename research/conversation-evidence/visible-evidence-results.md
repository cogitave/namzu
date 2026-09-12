# Binding visible conversation text to its archived source

Measured 2026-09-12. Baseline: `d5d2b9ad`. The final change is in SDK
`createEvidenceRecallStep`; ordinary CLI hosts consume its temporary context.
The feature remains opt-in through `compaction.recallEvidence`.

## What failed

The SDK suppressed a retained excerpt whenever the same raw or JSON-escaped text
was already in history. That avoided repetition, but also discarded the archive
address and recording time. Text visibility does not establish source visibility.

An initial implementation returned addresses and times without their matching
text. Its scripted CLI controls passed: a program could select the later time
and use the actual `read_conversation` tool. **The live Luna/low run failed.** Both
codes were in ordinary history, both addresses/times reached the request, but the
model selected the older code without using a tool. This failure is retained in
[the data](visible-evidence-results.json), including the exact supplied context,
answer, expected code, tool count and built-module hashes. Passing deterministic
controls had not established that the presentation worked for the model.

The final implementation binds each source to an exact `textQuote` from the
validated excerpt. This repeats a bounded quote where needed for association;
it does not reload the full source. The two facts are directly paired in the
model's context rather than relying on an inferred mapping between list orders.

## Source review and design

The inspected Pydantic AI Harness search description recommends using persisted
history when details are absent from current context. Its message renderer emits
text and run-local message numbers. That is a useful comparison, but an identical
body in current context need not carry its original source metadata. This
observation concerns the inspected search path, not every Pydantic memory feature.
[Source at c897c4e8](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py).

LongMemEval distinguishes temporal reasoning and knowledge updates from text
retrieval, and examines structured presentation as part of reading. Its results
do not establish that any JSON object is sufficient: the local address-only
failure here shows why the association itself matters. This is our interpretation
of the local experiment, not a reproduced LongMemEval score.
[LongMemEval, sections 5.4–5.5](https://arxiv.org/html/2410.10813v2).

The W3C Web Annotation model provides a useful anchoring principle: a text quote
identifies the text an annotation concerns, while position-only selectors can be
brittle under edits. Namzu uses the idea of explicit quote/source association;
`textQuote` is **not** a W3C-compatible selector implementation. It preserves raw
archive text, does not normalize HTML, and uses the SDK's existing UTF-16 excerpt
limit. Source authority still comes from validated host scope and archive bytes,
not from the quote alone. [Text Quote and Text Position Selectors](https://www.w3.org/TR/annotation-model/#text-quote-selector).

## Final contract

`visibleEvidence` entries contain `textQuote`, an `address` for an archive-read
tool, optional `recordedAt`, `source`, optional `toolName`/`isError`, and `retained`.
Each quote is exactly the validated candidate excerpt, at most 512 UTF-16 units.
Visible-message order, archive discovery order and source chronology remain
separate. The recorder timestamp is not proof of fact validity or cross-run
causality. Preview, error and unknown metadata retain their original meanings.

The SDK validates the whole candidate batch before exposing any references.
Visible candidates are ranked separately, so they cannot change new-text BM25
statistics. One source per distinct quote group is offered before extra copies.
Equal quote/reference metadata is deduplicated. Visible quoted references and
new passages share `maxPassages`; new text has priority. All metadata, quoted
text and JSON escaping also share the existing character ceiling.
`omittedVisibleEvidence` counts references withheld from this bounded pool by
those limits. It is not an archive-wide count or proof of absence.

The host can read a reference's `address` for text beyond the quote. That read
revalidates scope and source; no action is replayed. Scope, I/O ceilings,
cancellation and immutable durable history are unchanged. A complete pass with
only visible matches can now return quoted references or their omission counts.
Already-visible metadata is not treated as an authentication cache: sources are
revalidated and references may appear again on later matching steps.

## CLI experiment

[visible-evidence-cli.mjs](visible-evidence-cli.mjs) uses the production built CLI
through `run --resume`, with an isolated temporary home and workspace. Two closed
synthetic runs each hold a fresh random receipt code. Their event dates differ;
run-start metadata deliberately points to the opposite date. UUID order is fixed.
The ordinary conversation summary already contains both exact observation texts,
listed in reverse run-ID order, but has no dates or source IDs. The current
workspace file has no original code. The natural question is:

> What was the last recorded DELTA receipt code?

`--reverse` swaps the dates between the same two run IDs. A preload records the
actual temporary request context. Scripted controls replace inference only and
exercise the real archive-read tool. Live trials forward the provider request
unchanged to Codex `gpt-5.6-luna`, effort `low`, with a 25,000-token admission
budget, three-iteration ceiling and 90-second process deadline. Build hashes are
captured before and after every trial. New quotes and address validation still
use the existing four-page / 8 MiB automatic-read ceiling.

The machine-readable data records the baseline, the rejected intermediate
presentation, the quoted presentation before the final passage-cap check, and
both final capped live runs. Intermediate success is not substituted for testing
the final built implementation. No user transcript or credential is copied into
these results. The baseline is a metadata-availability control, not a live-model
failure. Scripted answers establish tool wiring, not model comprehension.

Measured outcomes (all live runs used Luna at low effort):

| Trial | Context characters | Requests / tools | Reported tokens | Exact answer outcome |
| --- | ---: | ---: | ---: | --- |
| Baseline, scripted | 0 | 1 / 0 | 0 | Visible texts lose their archive references |
| Unquoted references, scripted (both date orders) | 1,510 | 2 / 1 each | 0 | Archive read works |
| Unquoted references, live | 1,510 | 1 / 0 | 7,211 | Failed: older code selected |
| Quoted references, scripted before final cap | 1,703 | 2 / 1 | 0 | Archive read works |
| Quoted references, live before final cap | 1,703 | 1 / 0 | 7,279 | Passed |
| Quoted references, reversed dates before final cap | 1,703 | 1 / 0 | 7,293 | Passed |
| Final capped version, live | 1,703 | 1 / 0 | 7,284 | Failed: expected code prefix, corrupted tail |
| Final capped version, reversed dates | 1,703 | 1 / 0 | 7,293 | Passed |
| Final capped version, same-code stream diagnostic | 1,703 | 1 / 0 | 7,279 | Passed; native deltas, done text and CLI answer agree |
| Final capped version, scripted | 1,703 | 2 / 1 | 0 | Archive read works |

The final implementation therefore passed **two of three live exact-answer
checks**, including the same-code diagnostic; it did not achieve perfect answer
fidelity. The two successes before the final passage-cap change are recorded
separately. All live calls ended normally, made no tool calls and kept the current
workspace file unchanged. The scripted controls exercise read-only archive calls.
First-pass reads were 17,499 bytes whenever recall metadata was emitted. Baseline
I/O was not exposed because recall returned no context; zero context is not zero
I/O. Adding exact quotes increased this fixture's recall context by 193 characters
over unquoted references. The six live runs reported 43,639 tokens in total,
unpriced in provider accounting; zero reported monetary cost is not a price claim.

The final normal-order failure returned the expected code's first UUID groups
but a changed tail ending in `?`. Both ordinary history and the quoted reference
contained the complete correct code. The recorded completion already has the
wrong tail; that original run did not capture raw API deltas. Repeating those
same code values with native answer-stream observation returned the exact code,
and `response.output_text.delta`, `response.output_text.done` and CLI output
matched. This establishes no stream mutation **in the diagnostic run**. It cannot
retrospectively prove the origin of the earlier typo. The diagnostic logs answer
text only, not reasoning content, credentials or request headers.

The saved Codex replay state also exposed an independent continuity issue: in
both the failed-copy run and the successful diagnostic, its `content` was null
and `items` empty despite a nonempty assistant message. The current guard in
`packages/providers/openai/src/codex.ts:replayItems` requires equal content and
will reject that replay. This is not established as the cause of the single-turn
copy error; the producer and next-request behavior need a separate audit. The
data retains the minimal replay shape, not private reasoning payloads.

To reproduce from the repository root after building the chosen revision:

```sh
# On the baseline revision only:
node research/conversation-evidence/visible-evidence-cli.mjs --expect-missing
# On the final implementation, exercise a real archive read without inference:
node research/conversation-evidence/visible-evidence-cli.mjs
# Actual small-model checks with opposite date orders:
node research/conversation-evidence/visible-evidence-cli.mjs --live
node research/conversation-evidence/visible-evidence-cli.mjs --live --reverse
```

Do not rebuild while a trial runs. Live trials use existing installed Codex
authentication without printing or copying it. Each trial prints its temporary
artifact directory. `--records /absolute/path/to/result.json` reuses a previous
trial's two code values for a stream diagnostic; the new state and conversation
remain isolated. `--expect-unquoted` is a diagnostic assertion for the rejected
intermediate presentation, not a production feature or a way to remove quotes.

## Boundaries of the evidence

This is a small controlled chronology-and-source-association experiment, not an
aggregate memory benchmark, proof of optimal recall, or a claim of human-like
memory. Candidate discovery can still stop before relevant records are reached;
quotes cannot recover text beyond their retained source. Missing or conflicting
clocks do not acquire a reliable total order. Compaction copies date their copy
event, not their original statement.

The test seeds closed records and a projected history; it does not add a new live
compaction workload or visual TUI check. Real CLI Session, live/closed/legacy
source reads and existing compaction/restart/integrity regressions are checked
separately. This milestone does not enable automatic recall by default or publish
a release.

## Verification

Final workspace typecheck/build and unit/integration suites passed: SDK 6,407
tests; CLI 2,870 passed and five skipped; other workspace package suites passed.
SDK process regressions passed 257 cases in 37 files. Focused CLI source/Session
integration passed 59 cases; live, closed and legacy references were passed to
the real exact-read implementation. SDK recall's 47 tests include escaped quotes,
source/status preservation, existing-history immutability, shared passage and
character limits, omission accounting and priority for distinct visible quotes.
The first new omission test incorrectly supplied no operator query and was
corrected before these passes; production correctly skipped that queryless pass.

Lint passed with the existing 35 SDK and 14 CLI warnings. Documentation and
compiled-fence checks, signature exports (671) and SDK test presence passed.
These checks do not erase the live exact-copy failure above. Release-only
consumer-install, coverage and publishing gates were not run for this local
milestone; no push or publication was performed.
