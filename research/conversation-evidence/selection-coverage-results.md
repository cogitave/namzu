# Complete traversal does not mean complete model context

Measured 2026-09-12 on Linux/WSL, against baseline `b9e0f37a`.
This follows [bounded query refinement](refined-discovery-results.md).

## Verified defect

The SDK could retrieve five distinct matching records in a complete scan,
select four passages, and emit `incomplete: false` with no notice or address
for the fifth. If the character budget prevented every whole excerpt from
fitting, a complete batch produced no context at all. The source had been found,
but its existence and recovery path were lost at presentation.

The first baseline control returned four earlier receipts. A fifth receipt's
identifiers remained in the authenticated archive and candidate pool, outside
both its original preview and the temporary model context. No traversal cursor
remained because the source scan really was complete. This is a selection
coverage defect, separate from candidate discovery and source retention.

[LongMemEval](https://arxiv.org/abs/2410.10813) separates indexing, retrieval and
reading, and tests knowledge updates, temporal reasoning and abstention as
separate memory abilities. That distinction informs this test: finding a source
is insufficient evidence that a model saw its later value. This is a local
regression scenario, **not a LongMemEval run or a score on that dataset**.
The authors' [repository](https://github.com/xiaowu0162/LongMemEval) was inspected
for the benchmark's ability categories and session-evidence format.

## Implementation

The SDK keeps BM25 order, exact-group deduplication and the existing passage,
character, I/O and scope limits. It now records `omittedPassages`: eligible
positive-score distinct groups withheld by the passage or character allowance,
after excluding already visible text and exact copies. This is a bounded-pool
count, not the number of all relevant records in the archive.

`additionalEvidence` contains representative addresses of omitted groups, and
`omittedAddresses` counts addresses which could not fit. These fields reuse
already validated `runId`, `seq`, `part` and optional byte offsets. They contain
no omitted text, infer no cross-run chronology, and grant no authority. Exact
reads still validate scope and source integrity when actually performed.

Allocation order remains explicit: distinct passage text, traversal hints,
addresses of omitted passages, then additional addresses of selected exact
copies. Counts and JSON escaping consume the same character budget as text.
A notice can survive when no whole excerpt fits; a complete scan with no
eligible new text still adds nothing. An over-budget framing block is never
emitted. `incomplete` continues to describe traversal and can legitimately be
false alongside a positive omission count.

The CLI already mounts `read_conversation`; the new address works through that
existing tool. A successful read adds exact retained text to ordinary tool
history for the following model request. No tool action is replayed to recreate
its past output. The recall hook itself makes no model or tool call.

## Actual CLI measurement

[The script](selection-coverage-cli.mjs) creates isolated Namzu state and a
synthetic closed transcript. Four earlier short receipts precede a fifth,
oversized retained receipt with two fresh random UUIDs beyond its 1,000-character
preview. The chat projection holds only a summary. A workspace replacement
contains neither identifier. All five records share the query words, so ranking
and the four-passage limit withhold the fifth record.

Natural prompt: **“What were the tracking code and destination in the last
DELTA receipt?”** The script launches production `run --resume` with recall
enabled, four iterations maximum, a 30,000-token admission budget and a 90-second
deadline. Its preload records temporary context; scripted controls operate only
on received context or tool results, while the live trial forwards provider
calls unchanged to `gpt-5.6-luna` at `low` effort.

| Trial | First-pass read bytes | First context characters | Omitted receipt address | Requests | Tool calls | Exact final IDs recovered |
| --- | ---: | ---: | --- | ---: | ---: | --- |
| Baseline, scripted | 857,392 | 1,805 | Missing | 1 | 0 | No |
| Updated, scripted | 857,392 | 1,949 | Present | 2 | 1 read | Yes |
| Updated, Luna/low | 857,392 | 1,949 | Present | 2 | 1 read | Yes |

The live model read `seq: 6`, `part: 0`, `byteOffset: 83881`, returned both exact
IDs, and ended with `end_turn`. Neither ID appeared in the first request's
ordinary history or temporary excerpt text; the second request received them
from the archive read. The replacement workspace file stayed unchanged.
All build fingerprints were stable. [Results](selection-coverage-results.json)
retain synthetic observations, request evidence and module fingerprints.

Live usage: **15,532 unpriced subscription tokens**. The baseline is a scripted
observation control, not a paired live-model failure or a cost-saving claim.
The table accounts the automatic first pass only; the additional exact read has
its own I/O and token cost. This test used one run's sequence ordering. It does
not establish chronology across different runs or demonstrate a new real-time
compaction, TUI rendering change, or representative memory benchmark.

## Verification and remaining work

New SDK tests cover complete-scan selection loss, omission-only context when
no whole excerpt fits, exclusion of visible/copy/zero-score groups, and explicit
counts when addresses cannot fit. A real CLI Session test writes its archive
through the SDK, discards it from the chat projection, receives the omitted
address and executes only `read_conversation` before answering. Existing scope,
changed-artifact, compaction and resume tests also passed.

The initial new Session test failed while it consumed the old built SDK. The
first typecheck also caught a readonly test-fixture assignment, which was fixed.
After a successful typecheck/build, the targeted 56 CLI tests passed. Workspace
tests then passed: **6,384 SDK**, **2,867 CLI**, five CLI tests skipped, and all
other tested packages. SDK process tests: **257 passed**. Lint, docs,
documentation fences, exported signatures
and SDK test presence passed. Existing lint warnings remain: 35 SDK and 14 CLI.
No push, release or release-only coverage/consumer-install gate is claimed.

Remaining work: deciding which omitted addresses to read for a complex query;
representing verified chronology between invocations; measuring temporal and
contradiction questions with varied record order and abstention controls; and
handling semantic aliases which lexical retrieval does not discover. This
change discloses selection loss and makes direct recovery possible; it does
not claim that the ranking itself identifies the newest or correct statement.
