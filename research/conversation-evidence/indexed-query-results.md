# Selecting query words from the supplied text

Recorded 2026-09-13 on base `45c82920`.
[Raw observations, planner inputs and build fingerprints](indexed-query-results.json).

## Motivation and primary sources

The last [progress-heavy trial](query-history-results.md) failed after the
planner changed the Turkish word `kimliğini` to `kimliği`. The source-grounding
check correctly rejected that invented spelling, but optional recall then
supplied no historical passage and the action model answered from the replacement
file. Weakening quote validation would hide this failure rather than ground it.

[QuReTeC](https://arxiv.org/abs/2005.11723v1) formulates conversational query
resolution as deciding which existing history terms to add to a question. Its
[query-generation implementation](https://github.com/nickvosk/sigir2020-query-resolution/blob/da876054ea7dd97beeb84a4a941f2e69a1ba024b/generate_query_files_for_trained_model.py)
uses predicted relevance labels to select words from the model input. The paper
and this pinned code were inspected for this change. Namzu applies the selection
idea using its existing bounded inference callback; it does not train or run
QuReTeC, and this experiment is not a replication of its retrieval benchmarks.

## Implementation

The planner sees a vocabulary of `[number, exact word]` rows and returns integer
`termIds`. The kernel resolves them against the vocabulary it supplied. The
planner cannot regenerate an inflected or translated spelling through that
field. Source quotes remain exact-string validated, and every selected word
must still occur in the current question or a cited quote. An offered word from
uncited history is not sufficient grounding.

The vocabulary has at most 256 distinct spellings, prioritizing current input,
then recent operator messages, then recent assistant messages. Words longer than
256 UTF-16 units are omitted. Vocabulary rows and JSON escaping share the
existing 12,000-character system-plus-prompt allowance. The input reports omitted
spellings; accepted query metadata carries a positive omission count too.
If the history payload alone does not fit, planning is skipped and literal
retrieval remains available. The history window, archive scope and retrieval
limits do not grow.

At most sixteen offered IDs may be selected. IDs are local to one planner input;
they are not persistent message IDs or evidence addresses. The model-facing
recall context still contains resolved source words and quoted history positions.
The one-call-per-input cache, run accounting, cancellation, quote validation and
present-state guard remain in force. No additional model round or default recall
setting is introduced.

## Real CLI experiment

```sh
node research/conversation-evidence/natural-cli.mjs --referential --scripted-observation --progress-updates --recall-evidence --resolve-queries --check-current --check-topic --live
```

These are research-driver flags. A production CLI seed reads one large synthetic
source, emits seven progress messages alongside single-file glob calls, and
finishes. Only seed model decisions are scripted; file tools, retained output
and conversation storage are production code. Two random identifiers on source
lines 211 and 214 are outside the visible preview and absent from its short
summary. The driver replaces the source externally after the seed process exits.

Three separate CLI `run-stream` processes then reopen the same conversation:
request the earlier identifiers, ask for the current identifiers, and change
topic to Mediterranean climate. All query plans and follow-up decisions use real
`codex/gpt-5.6-luna` at `low` effort. Provider chunks pass through unchanged.
The observer records the bounded planner inputs so each chosen number can be
resolved independently against the words actually supplied.

The seed allows twelve iterations and 25,000 admission tokens, with scripted
usage zero. Historical/current/topic turns each allow four iterations and
120 seconds, with respective allowances of 30,000, 25,000 and 15,000 tokens.
Each planning call shares that allowance and permits at most 512 output tokens
and ten seconds. These are admission ceilings, not hard billing ceilings.

## Results

| Case | Outcome | Live tokens | Preparation tokens |
| --- | --- | ---: | ---: |
| Prior baseline `k5bP4H`, historical question | Failed: ungrounded term; answered replacement values | 18,222 | 642 |
| Indexed trial `dW3agw`, historical question | Both originals exact, no new tool call | 10,640 | 862 |
| Indexed trial, current-file question | Both replacements exact after fresh grep | 19,391 | 1,047 |
| Indexed trial, new topic | Correct topic, no shipping identifiers or tool call | 10,087 | 1,017 |

The historical plan selected IDs 9, 10 and 12, mapping to `sevkiyatlar`, `txt`
and `DELTA`. Its quote named the original request. Retrieval supplied both
original identifiers only in 3,737 characters of temporary recall context;
ordinary history still contained neither identifier at that request.

For the current-file question, the planner returned `mode: contextual` and
selected old code tokens despite setting `time: present`. The kernel's existing
temporal guard discarded that historical expansion. The first current-state
request had no recall context; the model made a fresh grep and copied the new
identifiers. This is a successful runtime guard around an imperfect plan, not
evidence that the planner followed every instruction.

The new-topic plan used `direct` with no selected IDs. Its main request had no
recall context and its answer contained no shipping identifiers. The source
replacement stayed unchanged throughout; built-module hashes matched before
and after the suite. All runs ended normally with zero unresolved budget
requests. The new suite used **40,118 live tokens across seven requests**.
The baseline is an earlier recorded run with different random identifiers, so
the cost difference is not a controlled effect-size or speedup estimate.

## Validation and limits

The focused SDK suites passed 93 tests, including Turkish spelling preservation,
unknown/noninteger IDs, uncited words, quote grounding, vocabulary/JSON limits,
omission counts, history selection, steering and fresh evidence validation.
The CLI Session suite passed 32 tests after rebuilding the SDK. Its initial run
against the older built planner failed two cases because the fixture expected
the new internal vocabulary protocol; that mixed-build run is not reported as
passing. The final full workspace tests passed: 6,618 SDK tests and 2,933 CLI
tests, with five CLI skips. Workspace build, typecheck and configured lint passed.
The docs conformance and fence checks, project references, SDK test presence,
publish metadata and exported signature checks also passed. This local change
has not been pushed or published; these checks do not claim a complete release
gate run.

This is one three-case live suite, not a general success-rate estimate. Selecting
an offered ID guarantees its spelling, not its relevance or truth. Quotes are
still generated text and can fail validation. Ambiguous references, absent
referents, incomplete vocabulary and constraints beyond the retained history
remain unresolved semantic boundaries. This suite reopens processes but does
not force compaction or exercise TUI keyboard rendering; existing scoped archive
and compaction tests remain separate evidence.

The next meaningful evaluation is reference selection across ambiguous subjects,
topic returns and missing antecedents, with independently declared expected
retrieval behavior. Repeating only the same successful DELTA question would not
establish those capabilities.
