# Bounded retrieval can skip nonmatching token windows

Measured 2026-09-13 on Linux/WSL, baseline `10e99841`.
[Probe](token-filter-cli.mjs), [measurements and module hashes](token-filter-results.json).

Automatic CLI recall uses whole-token, case-insensitive discovery. The existing
literal trigram filters encode exact case, so that mode previously read every
visited payload window. A sparse match deep inside a large retained output could
remain outside the initial automatic I/O allowance, even when its query words
were specific and the index already identified the correct source record.

## Sources and design

PostgreSQL's [Bloom index documentation](https://www.postgresql.org/docs/18/bloom.html)
describes small signatures used to exclude nonmatches, and requires rechecking
possible matches against original values because signatures can have false
positives. Namzu applies that principle to existing authenticated text windows;
this change does not add PostgreSQL or claim to port its index implementation.

The inspected Pydantic AI Harness
[conversation search at `c897c4e8`](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py)
materializes section index lines before BM25 ranking. Here the problem is the
cost of reaching candidates under Namzu's explicit read ceiling. This is source
comparison, not a competitor runtime benchmark or a change to BM25 ranking.

Each window's new signature inserts the same complete-token lowercase keys used
by `evidenceTokenMatcher`. Two derived hash positions set bits. Queries use the
same key and positions; a missing bit rejects a window. A positive result is
only permission to read, authenticate and run the exact matcher, never evidence
that a passage exists. Hash collisions and saturation cause extra reads. No
independent-hash false-positive probability is claimed for this implementation.

The raw bit array is 128, 512 or 1,024 bytes, selected by window length, then
base64-encoded. Small records therefore do not pay the largest signature cost.
A first implementation doubled every short record's filter and failed an
existing cached-page I/O test (251,759 bytes against a <200,000 bound). The size
selection fixes that regression; the test's bound was not relaxed.

Token iteration avoids an extra whole-corpus token array. Storage still holds
original output, and retention already buffers that output; this is not a claim
of constant total memory. Filtering adds tokenization, hashing and storage work
at retention/index creation. Dense varied text can saturate the signature and
eliminate most of its read advantage.

An algorithm tag also binds the writer's Node, V8 and Unicode versions, available
through [Node's runtime version metadata](https://nodejs.org/api/process.html#processversions).
This is a conservative compatibility choice: unknown tags fall back to exact
scanning instead of applying token negatives built under different semantics.
The version-mismatch test changes the stored tag; it is not a live benchmark
across several Node installations.

The existing manifest digest authenticates the new metadata. Token filters are
optional: old manifests still scan, and the encoder omits optional filters when
adding them would exceed the existing 4 MiB manifest limit. The previous output
retention ceiling is preserved. Disposable index pages use a new generation;
source keys, exact-read addresses, payload bytes and offsets stay unchanged.
Literal case-insensitive search does not use these filters because its Unicode
matching rules differ from token-key matching.

## Actual CLI fixture

The probe creates an isolated conversation and scoped historical run, then uses
the production tool-output retention path to archive **7,371,531 bytes**. A fresh
random receipt code begins after six MiB of unrelated padding, at byte 6,291,457.
More padding follows, so the visible preview contains no code. The workspace
file is a replacement containing no historical identifier; ordinary message
history is only a short summary.

The real built CLI executes `run --resume` with automatic recall enabled, web
and memory recall disabled, `gpt-5.6-luna`, effort `low`, a 25,000-token ceiling,
four iterations and a 90-second process timeout. The prompt is:

> What was the original ORCHID receipt code?

A preload records only actual runtime recall context. Scripted controls replace
inference and return the selected direct observation; live trials forward the
provider stream unchanged. Module fingerprints must remain stable. The probe
checks initial context, final answer, absence of the code in ordinary history,
zero tool executions, unchanged workspace replacement and unchanged historical
transcript. Historical data is seeded; this is not a model-generated long session
or TUI visual test. Large compaction/live/snapshot behavior also has SDK tests.

| Trial | Original in first context | Accounted read bytes | Manifest bytes | Incomplete | Model tokens |
|---|---|---:|---:|---|---:|
| Baseline, scripted | No | 8,378,287 | 167,745 | Yes | 0 |
| Initial filter, scripted | Yes | 736,008 | 324,250 | No | 0 |
| Initial filter, live Luna/low | Yes | 736,008 | 324,250 | No | 7,165 |
| Final tagged filter, live Luna/low | Yes | 739,059 | 327,301 | No | 7,162 |

The final live trial returned the exact original UUID in one model request with
no tool executions. It used about **91.2% fewer accounted read bytes** than the
scripted baseline's initial recall pass, while the manifest grew by **159,556
bytes**. This is a sparse-match I/O comparison, not a latency benchmark or a
paired model-quality score. Initial recall found its source within the same
8 MiB ceiling; no page, token or context allowance was raised.

The baseline still offered a continuation. Its intentionally successful negative
control means the initial selection missed the code, not that later explicit
search could never recover it. The fixed context is larger (1,568 vs 1,024
characters) because it now contains the actual observation.

One intermediate final-code live attempt returned the correct code but failed
our post-run observer: the probe counted `runs/index.json` as another invocation.
That failed result is preserved in the JSON report. Reading its actual invocation
transcript confirmed zero tool executions; the probe now counts directories and
the final live trial passed every assertion. Total live use including that
observer failure was **21,489 tokens**. Subscription usage is unpriced, not proof
of zero monetary cost.

## Verification and remaining bounds

Tests cover Unicode lowercase expansions and contextual sigma, numeric and
identifier keys, astral/CJK tokens at UTF-8 chunk boundaries, maximum-length
queries, old/unknown filter tags, saturated signatures which require exact
rechecking, manifest-size fallback, and changed positive chunks. Closed, live
and nonterminal snapshot sources reach a distant match under a 1 MiB per-call
ceiling. Exact reads still reproduce original text and reject altered bytes.
The property test runs 100 generated multilingual token sets. Existing literal,
case-sensitive and cursor tests are retained.

Final workspace typecheck, build, lint and recursive tests passed. SDK passed
6,528 tests; CLI passed 2,912 with five skipped; SDK process tests passed 264.
Other workspace packages passed their configured suites, with existing optional
and platform skips. Docs OKF, 47 TypeScript fences and 20 package README checks
passed, as did workflow parity, project references, SDK test presence, exported
signatures, external-name and log-standard checks. This is local validation, not
a release, publish or multi-provider live benchmark.

A negative signature authenticates what the original index excluded; it does not
perform a whole-file integrity audit of every skipped payload chunk. Explicit
reads still authenticate requested bytes. Source ownership and cancellation
checks remain enforced. Automatic discovery is still bounded and opt-in; common
query words, many relevant records, saturated filters, unindexed old outputs and
traversal limits can still require explicit continuations. This does not solve
semantic retrieval, contradiction resolution or general long-term intelligence.

## Reproduce

Run from a built repository. `--live` consumes provider quota:

```sh
node research/conversation-evidence/token-filter-cli.mjs
node research/conversation-evidence/token-filter-cli.mjs --live
```

Run the same probe with `--expect-missing` in a separately built baseline checkout
to reproduce the initial miss. Each invocation prints its temporary artifact
folder. No credential contents or user conversation history are included.
