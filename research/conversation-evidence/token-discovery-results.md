# Token-aligned discovery in the SDK and CLI

Measured 2026-09-12 on Linux/WSL after the
[candidate-selection ablation](candidate-alignment-results.md). Its concrete
substring mismatch is now addressed in production code. Frequent complete
query words remain a separate candidate-allocation problem.

## Implementation and source basis

SDK evidence search adds optional `matchMode: 'token'`. Discovery and bounded
BM25 scoring share Unicode letter/number/underscore units and lowercase keys.
The default literal mode retains substring matching. Token mode rejects empty
browsing, phrases and punctuation expressions rather than silently changing
their meaning. Its cursor binds mode, query/terms, case and scope; the new token
kind is refused by older cursor readers.

This follows the consistent query/document tokenization principle described in
[Introduction to Information Retrieval](https://nlp.stanford.edu/IR-book/html/htmledition/tokenization-1.html)
and inspected in the pinned Pydantic AI Harness
[ranking source](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py).
Namzu's authenticated paged source is its own implementation; no comparative
model score or throughput advantage over that project is claimed.

At a spill chunk boundary, token matching needs the preceding code point.
The source verifies that preceding chunk against the retained manifest and
charges its bytes to the existing read ceiling. UTF-8 characters split across
chunks, astral letters and non-letter delimiters are handled before matching.
Search begins after the contextual prefix, so it cannot emit the previous
chunk's last token twice. Raw text, byte offsets and character offsets remain
consistent with exact reads. Missing character indices remain unknown.

Automatic CLI recall selects token mode for live writers, closed indexes and
legacy full-record scanning. Its model-facing continuation restores the mode;
ordinary new `search_conversation({query: ...})` calls keep literal semantics.
No additional model tool argument, cross-session access or action replay is
introduced. The SDK recall opt-in and I/O/candidate ceilings do not change.

## Recorded-source comparison and production CLI

The [script](token-discovery-cli.mjs) creates one synthetic prior invocation:
twelve distinct `Packing information` records followed by an oversized original
observation containing two fresh UUIDs. Both UUIDs are outside its visible
preview. The conversation projection has only a summary, and the workspace file
contains a replacement without the original codes.

Natural prompt: **“What were the tracking code and destination in the original
DELTA observation?”**

Actual SDK term extraction includes `in`. Against the same authenticated source,
four literal pages each return three irrelevant passages and still have a cursor.
Token mode skips those substrings, reaches the original, and completes its scan
in one page:

| Source mode | Pages visited | Original found | Read bytes |
| --- | ---: | --- | ---: |
| Literal, stopped at four-page allowance | 4 | No | 91,229 |
| Token | 1 | Yes | 413,860 |

The token scan reads **more** bytes here because it reaches and verifies the
oversized original and boundary context. Fewer pages are not an I/O saving.
Both measurements stay within the existing limits. These source comparisons
use separate reference index directories and are not old-build CLI runs.

The production CLI is then launched with `run --resume`, automatic evidence
recall enabled, at most four iterations, a 20,000-token admission budget and a
90-second process deadline. A scripted control returns the actual request
context; the live preload records context and forwards provider decisions
unchanged to Codex `gpt-5.6-luna` at `low` effort.

| CLI trial | Provider requests | Tool calls | Exact codes recovered | Tokens |
| --- | ---: | ---: | --- | ---: |
| Scripted control | 1 | 0 | Yes | 0 |
| Luna/low | 1 | 0 | Yes | 7,025 |
| Final scripted control | 1 | 0 | Yes | 0 |

Both original identifiers were absent from ordinary history and present in the
first request's temporary evidence context. The live model returned both exact
values and ended with `end_turn`. No workspace reads, mutations or historical
action replays were requested, and the replacement file stayed unchanged.
Build fingerprints were stable during each trial. The live usage was reported
as unpriced tokens; unknown pricing is not zero cost.

## Validation and limits

SDK tests cover numeric and technical substring distractors, Unicode casing,
long token matches across excerpt ends, exact offsets, UTF-8 chunk boundaries,
damaged preceding chunks, mode changes, invalid input and cancellation. A real
process test continues a token cursor and reads its address after process
restart. CLI tests cover live/closed/legacy discovery, cursor-only restoration
and preservation of explicit literal search. Existing real Session compaction,
scope-refusal and altered-artifact tests also passed.

SDK unit tests: **6,362 passed**. SDK process tests: **257 passed**. The initial
workspace run encountered a status-read timeout in the goal TUI tests. Its
focused rerun passed that case but timed out in a different held-goal-write
case. A final full CLI run passed **2,861 tests**, with five skipped. These
intermittent waits remain recorded and unexplained, not relabelled as fixed.

Typecheck, build, lint, docs, fences, exported signatures and test-presence checks
passed. This is one successful live CLI retrieval over a synthetic prior
transcript, not a new live-compaction run, TUI visual inspection or representative
benchmark. The common-whole-word counterexample remains open. No push, release
or release-only coverage/consumer-install gate is claimed.
