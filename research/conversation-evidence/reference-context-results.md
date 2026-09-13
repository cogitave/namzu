# Returning to a subject, clarifying it, and withholding an absent value

Recorded 2026-09-13 on base `64461824`.
[Driver](reference-context-cli.mjs) · [Raw observations and manual assessments](reference-context-results.json).

## Question and sources

The earlier [indexed-query experiment](indexed-query-results.md) established
exact source-word selection in one historical/current/topic sequence. It did
not establish which subject to choose when several records are visible.

[ClariQ](https://arxiv.org/abs/2009.11352v1) treats ambiguous information requests
as a clarification problem. Its [official evaluator](https://github.com/aliannejadi/ClariQ/blob/master/src/clariq_eval_tool.py)
separates clarification-need prediction, question relevance and document
relevance. These primary sources were inspected when designing this probe.
Namzu does not run that dataset or evaluator here. The useful distinction is
that returning a document and correctly deciding to ask a question are separate
outcomes; a no-answer case must not automatically count as failure or success.

## Declared expectations and method

The driver declares these expectations before any live request:

| Case | Conversation | Required behavior |
| --- | --- | --- |
| Topic return | Inspect DELTA, then OMEGA, discuss climate, ask for the first record's earlier code | Return original DELTA only |
| Ambiguous | Inspect DELTA and OMEGA together, ask for “that record's” earlier code | Clarify which record; do not guess a subject |
| Missing | Inspect DELTA, ask for an earlier SIGMA code | Search if needed and withhold an unverified value |

Each case has its own temporary home, workspace and conversation. Seed model
decisions are scripted; real CLI file tools read a 400-line synthetic document,
and production stores retain the oversized output. Random DELTA and OMEGA codes
are on lines 211 and 261. The probe verifies both codes are in the retained
output and neither is in visible seed events. No seed summary prints them.
The file is then replaced externally with different codes before the live
follow-up reopens the conversation in another CLI process. The source is checked
unchanged after each follow-up. There is no SIGMA record in either file version.

The source read contains both records even when the seed asks about one. The
subject-selection rubric comes from the conversation's requests, not a claim
that the file tool saw only one record. The climate detour leaves six eligible
history messages, so the original request is still within the planner's window.

```sh
node research/conversation-evidence/reference-context-cli.mjs
node research/conversation-evidence/reference-context-cli.mjs --live
```

Without `--live`, only fixture eligibility is checked; no model performance is
claimed. The first two fixture attempts found driver defects: an allocated run
directory without a transcript, then a reused scripted tool-call ID on restart.
The driver now tolerates unrecorded directories and assigns distinct tool-call
IDs. The third fixture suite passed all three cases with zero live tokens.

Each live case uses `codex/gpt-5.6-luna`, `low` effort, at most four iterations,
a 25,000-token admission allowance and a 120-second process deadline. The
planner's existing 512-output-token and ten-second limits remain. Seed turns
allow three iterations and 15,000 admission tokens with scripted usage zero.
These are admission limits, not hard billing ceilings: the baseline ambiguous
run used 26,250 tokens and the updated missing run used 28,250.

The observer passes provider chunks through unchanged and records visible text,
usage, bounded planner inputs and temporary step context. It records no private
reasoning text. All runtime/build fingerprints remained stable within each
suite. This is a headless `run-stream` process experiment, not a TUI keyboard
test or forced-compaction trial.

## Failure and change

In baseline `iZde1D`, the ambiguous question produced a planner `none` decision.
The SDK skipped recall and discarded the reason. The main model then ran two
greps and a read against the replacement file and said it contained only new
codes. It never asked which record was intended. The absence of returned codes
does not satisfy the declared clarification requirement.

The internal planner now has an `ambiguous` outcome: no selected search terms
and up to three exact quotes of the competing references. Quotes must match the
supplied history. The SDK emits a bounded planning note instead of retrieving
an arbitrarily chosen subject. It labels the note as a fallible interpretation,
preserves the operator's request and asks the main model to clarify if needed.
It does not claim archive evidence or prove semantic ambiguity from string
matching. An explicitly named missing subject keeps literal discovery.

This uses the existing optional planning call and context allowance. Notes are
request-only, preserve earlier prepared context, are dropped if serialized text
does not fit, and stop on cancellation. New operator input invalidates the old
interpretation. SDK defaults and CLI configuration keys are unchanged.

## Observations

| Case | Baseline | Updated | Live tokens, baseline → updated |
| --- | --- | --- | ---: |
| Topic return | Correct original DELTA, no tool | Correct original DELTA, no tool | 11,770 → 11,711 |
| Ambiguous | Failed to clarify; three current-file observations | Asked DELTA or OMEGA; no tool | 26,250 → 9,273 |
| Missing | Searched SIGMA; withheld code | Searched twice; withheld code | 17,102 → 28,250 |

The updated ambiguity note was 792 characters. No code was supplied in temporary
context, and durable `messages.json` files contained no planning note. Topic
return succeeded even though its recall pool included both records. The main
model selected DELTA from the conversation's first request.

The updated missing case still has a retrieval weakness: literal terms such as
“code” match unrelated record passages. It supplied both other records in
temporary context and searched `SIGMA takip kodu`, then `SIGMA`. Both explicit
searches returned no matches, `incomplete: false` and zero unavailable runs.
The final answer withheld a value, but this was more expensive than the baseline.
The two suites used 55,122 tokens over nine requests and 49,234 over eight,
respectively. Different random identifiers and single samples do not support
a general cost-reduction or success-rate claim.

One presentation defect remains in the updated ambiguity answer: the clarification
question appears twice. Inspection of the retained native Responses output found
two distinct completed message items containing identical text. They have no
`channel` field, but do have `phase: commentary` and `phase: final_answer`.
The Codex driver's text accumulation currently flattens both phases into one
answer; native replay still preserves the distinct items. This identifies a
phase-handling gap before TUI rendering, not a redraw bug. No arbitrary text
deduplication was applied. The clarification decision passed; the displayed
response remains imperfect until phase separation is implemented.

## Verification and remaining boundaries

The four focused SDK suites passed 100 tests. Seven new cases cover unsupported
ambiguity claims, ephemeral composition, cached planning, clearing the note on
clarification, escaped-context limits and cancellation. Full workspace tests
passed: 6,625 SDK tests and 2,933 CLI tests, with five CLI skips. Workspace
typecheck, build and configured lint passed.
Docs conformance and fence gates, exported signatures, SDK test presence and
publish metadata checks passed. This is local work; no complete release gate
run or published package is claimed.

This change transfers a previously discarded decision into the main loop. It
does not guarantee the planner recognizes all ambiguities, recover references
outside its retained window, or enforce the final model's choice. The next
retrieval issue is preserving an explicitly named subject when common field
words match other records. The concrete protocol issue is carrying native
commentary/final-answer phase boundaries through text accumulation without
damaging signed replay or losing progress updates.
