# Whole-part coverage in conversation recall

Date: 2026-09-13. Base: `691342cc`. Local unpublished change.

The SDK and CLI now distinguish a fully displayed text part from a partial
excerpt and a retained preview. This closes a metadata gap; the live experiment
**does not establish better factual accuracy or lower token use**. The model
still asserted an unsupported historical assistant claim as an observed file fact.

## Why this change

`retained: full` means the archive has the original part. It did not say whether
the model had already received that entire part. In the preceding claim-only
trial, the full short assistant message was in automatic recall, yet the model
searched twice and read the same part before stopping without an answer.

Search and source records are separate concepts. [Letta's message API](https://docs.letta.com/api/python/resources/messages)
exposes `embedded_text` alongside the raw `message` and its role in
`MessageSearchResult`. That is a primary-source comparison of representation
boundaries, not evidence that Letta implements Namzu's coverage flag or that
this experiment outperforms it.

Namzu derives `excerptComplete` from validated UTF-8 bounds: full retention,
byte offset zero, and excerpt byte length equal to the source part's byte length.
The disk and live readers already validate the relevant source/manifest/chunks.
No extra archive read, model call or persisted schema was added. Tail excerpts,
long sources and retained previews cannot become whole merely because the
returned text is short. A whole text part does not cover other parts, prove a
claim or make an incomplete scan exhaustive.

Automatic recall preserves this optional flag in selected passages and visible
references. Unknown, false and true copies remain distinct. Its explanation
shares the existing character budget. Explicit CLI search carries the flag;
legacy transcript scans leave it unknown. Exact-read authorization, integrity
and cancellation remain independent checks.

## Controlled CLI results

The reusable [probe](record-origin-cli.mjs) seeds scripted archive records, then
runs a new real CLI process with `run --resume`, Codex `gpt-5.6-luna`, effort low,
three iterations, a 20,000-token admission budget and 120-second process deadline.
The seed is **not** a prior live model observation. Initial normal context has
no receipt identifier. The current file has no historical value. Web, memory
recall and query planning are disabled; automatic archive recall stays on.

[Observation JSON](excerpt-coverage-results.json) includes selected excerpts,
prepared contexts, public answers, tool calls, usage and stable build hashes.
Source archives and the current file were unchanged in every new sample.
The previous samples are in [the origin report](record-origin-results.json).

| Case | Before this change | With coverage metadata |
| --- | --- | --- |
| Original file value, only an assistant claim survives | Two searches and one same-part read; token budget ended without an answer | Two searches, then incorrectly asserted the assistant's claim as the original file value |
| What the assistant previously said | Exact code, but attributed it to the user | Exact code, correctly attributed to the assistant; zero tools |
| Conflicting tool observation and assistant claims, offline transport | Both producer kinds selected | Both producer kinds selected; all selected short parts carry verified whole-part coverage |

The claim-only sample used 23,319 tokens versus 22,973 before. The said control
used 7,327 versus 7,225. New live usage totals **30,646 tokens**. Admission is
checked before a call and cannot guarantee a hard billing ceiling: one admitted
response can cross the limit. Provider cost was unpriced, not proven free.
The first short-record recall context grew from 1,531 to 1,797 characters; the
offline conflict context grew from 2,964 to 3,299. No accuracy or cost aggregate
can be inferred from these individual, stochastic samples with fresh identifiers.

The missing read call is an observation, not proof that the flag caused it.
The correct speaker attribution is one control sample, not a general fix. The
unsupported original-file answer is a failure even though the process ended
normally and the quoted identifier existed in the archive.

## Actual terminal and validation

An 80-column, 28-row TUI resumed the offline conflict conversation. The assertion
transport checked producer kinds, whole-part flags and guidance in the prepared
request, then returned an acknowledgement. The composer accepted a message,
returned to idle and `/exit` ended with code zero. This tests the real interactive
host and storage path, not vendor reasoning. Local traces:
`/tmp/namzu-record-origin-M50T44/tui-excerpt.ansi` and `tui-excerpt.jsonl`.
An initial launch used the headless-only `--cwd` option and was rejected before
startup; the successful interactive launch used the intended working directory.

Focused checks passed: 129 SDK tests and 61 CLI tests. New cases cover Unicode,
512-unit boundaries, short tail excerpts, previews, reopened sources, live and
snapshot data, visible references, invalid coverage claims, grouping and context
budgets. The existing oversized compaction test also verifies a short whole
text part inside an archive with a large attachment. Initial test failures were
fixture errors: an unsupported page size/key, missing tool metadata, and an
incorrect assumption that a batch containing a retained preview was exhaustive.
Those fixtures were corrected without changing the source's limits or integrity
checks. Final full-suite counts and gates are in the observation JSON.

## Remaining work

Source retention, excerpt coverage, producer attribution and factual support
are different contracts. The first two can be checked against host-owned bytes.
The latter two still depend on semantic interpretation. The next bounded
investigation should inspect explicit search/read results together with the
SDK's existing answer-review capability, using the recorded unsupported-claim
failure as a negative control. Do not count normal termination, an exact string
match, or re-reading the same claim as independent evidence of correctness.
