# Keeping the operator request behind progress updates

Recorded 2026-09-13 on base `d1be0beb`.
[Raw observations and module fingerprints](query-history-results.json).

## Failure and change

The query resolver selected the six latest eligible operator/assistant messages,
then required an operator message in that selection. Six assistant progress
updates could therefore disable resolution even when the preceding request was
still visible within the allowed 64-entry scan. Two added regressions, with six
and twenty updates, failed before implementation: no planning call was made.

The selector now reserves a place for the nearest preceding operator request
when updates would occupy all six places. It replaces the oldest selected update
and preserves chronological order. The candidate-history scan still stops after
64 entries; the
planner still receives at most six excerpts, each at most 600 UTF-16 units.
Text, quote positions, source exclusions, budget and cancellation rules retain
their existing meaning. This is reference selection, not a stored task model.

## Primary-source comparison

[CONQRR](https://arxiv.org/abs/2112.08558v3) studies rewriting conversational
questions into standalone retrieval queries, trained using retrieval rewards.
Its problem formulation supports distinguishing a follow-up's words from its
dialogue context. This selection fix does not implement its training algorithm
or inherit its benchmark results.

The inspected [Pydantic conversation search implementation](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py)
ranks persisted messages with BM25 and limits contextual windows to the matched
run, under the configured search scope. That is a retrieval reference; it does
not establish that the correct query will be generated from a short follow-up.
Both primary sources were revisited on the date above.

## CLI protocol

```sh
node research/conversation-evidence/natural-cli.mjs --referential --scripted-observation --progress-updates --recall-evidence --resolve-queries --live
```

The new flag is for this research driver, not the Namzu CLI. The seed uses the
real CLI `run-stream`, file tools and persistence, with scripted model decisions:
one large source read, seven harmless single-file glob calls with progress text,
then a short completion. These deliberately generate eight assistant text
messages without the subject or original identifiers. They are not spontaneous
live-model behavior. The driver checks all seven progress messages were recorded.

The original request names DELTA. Two random identifiers occur on source lines
211 and 214, outside the read preview. They are retained by production storage
but absent from the visible initial conversation. After the seed process exits,
the fixture replaces the source with different identifiers. A separate production
CLI process reopens that conversation and asks:

> Az önce baktığın kaydın iki kimliğini aynen yazar mısın?

The follow-up and any query planning use real `codex/gpt-5.6-luna`, effort `low`.
Model chunks are observed and forwarded unchanged. The seed allows twelve
iterations and 25,000 admission tokens (scripted usage zero). The follow-up
allows four iterations, 30,000 admission tokens and 120 seconds. Preparation
shares that allowance, with the existing 512-output-token/ten-second bound.
Admission limits are not hard billing ceilings. No check-current or new-topic
model turns were requested for these trials.

The baseline used the previously built selector before the source change was
rebuilt; the recorded source hash already describes the working implementation.
Before/after built-module hashes establish which implementation ran and confirm
neither run changed its build during execution. The updated trial used a complete
workspace build. The driver's old fingerprint path was corrected from the
renamed `preparation-inference` module to the actual `callback-inference` module.

## Results

| Observation | Baseline `iHuCNZ` | Updated `1HEFus` |
| --- | --- | --- |
| Planning calls | 0 | 1 |
| Original identifiers in temporary recall | Neither | Both |
| Original identifiers in ordinary history | Neither | Neither |
| Fresh file observations during follow-up | 1 grep | 0 |
| Final answer | Wrong: replacement values | Both originals exact |
| Main model calls | 2 | 1 |
| Total live tokens | 17,512 | 10,203 |
| Of which preparation tokens | 0 | 642 |
| Source replacement unchanged | Yes | Yes |
| Built modules unchanged during execution | Yes | Yes |

The updated plan quoted the original request, selecting DELTA along with words
from the current question. Its temporal label was `unspecified`, not `past`:
grounded quotes are not proof of perfect intent classification. Production
retrieval supplied both original identifiers in 3,088 characters of temporary
context. The model copied both without workspace or explicit archive tool calls.

These first two follow-ups ended normally with no failed tool call. The baseline remains a
failed historical-answer case despite normal termination. Total live spend was
27,715 tokens across four requests for these two trials. They used different random IDs and
separate seed conversations; their cost difference is not a general effect-size
or latency claim. This experiment reopens a process but does not force compaction.

## Boundaries

Preserving one preceding request does not recover all goals, constraints or
acceptance criteria. Excerpts may omit the beginning of long requests. A request
outside the scan window or removed by compaction remains unavailable to this
planner. Its six-slot input is a bounded selection, not the entire conversation.
Automatic evidence recall remains opt-in; the explicit query-resolution opt-out
is covered through the real Session host.

## Repeated steering question

A second diagnostic ran the real SDK loop with scripted responses: inspect
ALPHA, ask a short question, switch to DELTA, then send the same short question
while an observation tool runs. The kernel correctly accepted the new steering
input, but query preparation searched backwards for an equal string and stopped
at the old ALPHA question. Its entire planning history was `Inspect the ALPHA
receipt.` The run ended normally after three zero-token scripted requests.
Both the isolated selector and full-loop regressions failed with ALPHA where
the most recent DELTA request should have been available.

The resolver now uses the actual retained message object to locate a boundary
when it is present. When that input is outside visible history, it considers the
bounded recent visible history instead of assigning an older equal string as
its position. This supports tool-result steering without parsing arbitrary tool
text. A checkpoint's detached copy is likewise not assumed to be an older
message based on spelling or timestamps. Without retained-input metadata, the
existing text fallback remains available to custom hosts.

The current topic now reaches planning in the same SDK regression. This is
scripted transport over the real kernel, not a live-model accuracy result or a
TUI keyboard trial. Missing message identity is still missing: the bounded view
can include visible work after the original input, and does not claim an exact
snapshot from its original acceptance time. Long-task constraint retention and
ambiguous references still need their own behavioral evaluations.

## Further live failures and term handling

The complete experiment also includes two later failed trials; the single
successful recovery above must not be read as the final implementation's
overall success rate.

| Trial | Planning outcome | Final answer | Live tokens |
| --- | --- | --- | ---: |
| `RjOcdt`, after steering-boundary fix | Grounded `sevkiyatlar.txt` rejected by single-word schema | Wrong: replacement values | 18,177 |
| `k5bP4H`, after compound-term fix | Generated `kimliği` is absent from the current `kimliğini` wording and cited quote | Wrong: replacement values | 18,222 |

The first plan quoted the correct original request and selected DELTA along
with its filename. The old schema rejected that filename before retrieval could
use the grounded subject. The resolver now tokenizes punctuation-separated
terms using the same word units as discovery. Grounding applies to every
expanded token; the expanded set must still fit sixteen tokens. Whitespace
phrases, unknown tokens and over-limit expansions still fail. This changes
search units, never archive bytes or identifier spelling in a final answer.
A failing filename regression became passing; the real CLI Session regression
also supplies a filename term and checks retrieval with and without progress,
plus the query-resolution opt-out.

The final live trial found a different boundary: the planner inflected a Turkish
word not present in its supplied text. Running that exact response through the
built validator reports `Query resolution introduced an ungrounded token.`
The valid filename no longer causes this refusal. Optional preparation fails
open and the main model then chooses the replacement file, giving the wrong
historical answer. Neither normal termination nor passing transport tests makes
that run successful. All four trials are preserved in the raw report; total
live spend is **64,114 tokens across ten requests**, with no unresolved budget
requests and unchanged source/build fingerprints within each trial.

No further live retry was made to obtain a green result. The next experiment
should evaluate selecting references to supplied word tokens instead of asking
the planner to regenerate their spelling. It must preserve grounding, bounded
input, source scope, current-state handling and explicit failure when the
referent is absent; accepting an invented token is not a fix.

## Validation of the final code

The focused SDK selection, steering and recall suites passed 88 tests. The
production CLI Session suite passed 32, including punctuation-token retrieval
and the explicit opt-out. The final full workspace test command passed:
6,613 SDK tests and 2,933 CLI tests (five CLI skips), along with the other
workspace package suites. Workspace build, typecheck and configured lint passed.
Docs conformance, compiled fences, signature exports and SDK test presence also
passed. No package publication or complete release-gate run is claimed.

These regressions establish the selection, transport and validation changes.
They do not override the two later live failures above or establish semantic
success for an arbitrary multilingual follow-up.
