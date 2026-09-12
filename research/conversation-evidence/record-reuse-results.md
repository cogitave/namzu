# Reusing authenticated compaction records within a search

Date: 2026-09-12. This measures a specific repeated-read cost in Namzu, not an
overall harness score or a comparison of model intelligence.

## Evidence and design

On baseline `1d651d03`, a closed-source search read and parsed the same JSONL
record again for each textual part. A compaction record containing many messages
therefore multiplied physical reads, even though each operation obeyed its byte
ceiling. Case-insensitive queries, as used by the CLI by default, visit the text
instead of skipping it with the case-sensitive negative filter.

A 2,048-message archive containing about 8 MB of ordinary text and one receipt in
its last message demonstrated the cost. Both scans recovered exactly event 2,
part 2047, without unavailable evidence. An independent 128-message inline-record
regression failed to finish in two pages before the change:
`/tmp/namzu-text-reuse-baseline.log` (21 passed, one failed).

The SDK now keeps at most one parsed, authenticated record inside a single search
operation. Its identity includes offset, length, digest and sequence. Visiting
another part of that record reuses that validated data. The next operation
starts with no such state. Both closed and captured live readers use the same
implementation; exact reads still authenticate their source. This removes
repeated whole-record reads and decoding, while preserving part order, source
labels, query semantics, 64-part pages and read ceilings.

Text manifests and chunks are still read and authenticated independently.
Cancellation is checked even when reusing a record. A modified closed transcript
is rejected before a search result is returned. This uses the existing private
filesystem trust boundary; it does not turn live append-only capture into a
hostile-filesystem snapshot protocol.

## Measurements

Reproducer after building the packages:

```sh
node research/conversation-evidence/compaction-scan-cost.mjs
```

| Closed search | Before: calls / bytes | After: calls / bytes |
|---|---:|---:|
| Cold index | 64 / 417,532,404 | 32 / 23,759,066 |
| Warm index | 64 / 415,814,262 | 32 / 22,040,924 |

Read accounting fell 94.3% cold and 94.7% warm. Every result stayed within the
same per-operation limit. The remaining 32 calls reflect the 64-part page limit;
the archive is not searched in one unbounded operation. Counts here are SDK
search calls, not a live model's decisions or model-token savings.

Recorded elapsed times were 9,189 → 3,599 ms cold and 9,009 → 3,222 ms warm. These
are single local samples, without CPU isolation, and do not establish a latency
guarantee. The byte and call counts are the relevant regression measurements.
They exclude archive writing, whole-event restoration and CLI startup reads.

[Raw results](record-reuse-results.json) preserve the before and after samples.
Their roots were `/tmp/namzu-archive-scan-cost-KDPWbO` and
`/tmp/namzu-archive-scan-cost-s6AZus`. The initial measurement script did not record
built-file fingerprints; the checked-in reproducer now records and compares them
within each execution. The earlier samples are not presented as fingerprinted.
The final run at `/tmp/namzu-archive-scan-cost-UwGapw` recorded unchanged build
fingerprints and reproduced both byte and call counts exactly.

## CLI path and compatibility

The first real CLI Session test exposed a second source of extra pages: manual
compaction still emitted one event per removed message. That was an earlier
workaround for oversized JSONL lines. Its five-turn recovery assertion failed;
the SDK optimization alone did not fix that different record shape.

Manual compaction now emits the same removed-message array used by automatic
compaction. The SDK handles its size and indexes individual text parts. A real
CLI Session compacted an original detail after 127 ordinary messages, saved the
actual replacement and reopened. A scripted provider recovered it through two
search calls, two exact-read calls and a final answer: five model turns. No file
inspection or state-changing action was replayed.

The CLI changeset is major because the documented maintenance-event cardinality
changes. Raw consumers must iterate `messages` and use returned `seq`/`part`
addresses. Existing archives and SDK readers still work. This is not an SDK API
rename, a new default budget or a context-window increase.

## Verification boundaries

Regressions exercise cold/warm searches, late parts, exact reads and reuse across
different records. Cancellation during a later archived part is tested through
both live and closed readers. A timestamp mutation during a closed search must
reject that operation; a fresh search must then observe the changed timestamp,
proving record state is not reused across calls.

Full workspace tests passed, including **6,447 SDK** and **2,884 CLI** tests
(five existing CLI skips). All **259 SDK process tests** passed. Typecheck/build,
lint, docs validation/fences, signature exports and log/name gates passed. Lint
retains the existing 37 SDK and 14 CLI warnings. Release-only gates were not run;
this work was not pushed or published. The first build caught a readonly-array
assignment in the manual adapter; copying the array fixed it before the successful
build and command experiments.

The restarted production CLI command also exercised the dense history:

```sh
node research/conversation-evidence/manual-compaction-cli.mjs --dense
node research/conversation-evidence/manual-compaction-cli.mjs --dense --live
```

The scripted run at `/tmp/namzu-manual-compaction-cli-A9dAXP` recovered the exact
original through two searches and two reads. The first read returned an empty
page with a continuation; the second read returned the original passage. The
initial test driver prematurely treated the empty read as final. Its failed run
at `/tmp/namzu-manual-compaction-cli-GTuypk` is not counted as a success. The driver
was corrected to continue reads, including empty scan pages, before the live run.

The live Codex / gpt-5.6-luna / low run at
`/tmp/namzu-manual-compaction-cli-7gGkU2` returned the correct receipt after two
searches and one read, consuming **33,098 unpriced tokens** under its 45,000-token,
six-iteration bound. But that read contained no original text and required a
continuation. The model answered from the search excerpt without continuing.
This proves correct excerpt retrieval, **not completed exact-text recovery**.

The first experiment verifier checked the final value and the presence of a read
call, so it incorrectly reported this live run as fully passed. A post-run audit
records the missing exact read alongside the untouched original result. The
verifier now requires the original code in an authenticated, non-preview read
result. The recorded zero priced cost does not imply free model usage. No paid
call was repeated merely to repair the verifier.
The corrected verifier passed the scripted command at
`/tmp/namzu-manual-compaction-cli-D925k1` with two searches and two reads.

This leaves a concrete CLI improvement: a read following a known search match
currently locates its authenticated address again from the first index page.
Preserving the source-scoped search address for that follow-up read could remove
this empty-page detour without weakening authentication. It is not implemented
or claimed complete in this increment. The Session regression is scripted, and
neither command experiment visually inspects a terminal layout.
