# Discovering originals behind derived summaries

Measured 2026-09-13. Baseline `df686fc7`.
[Driver](summary-discovery-cli.mjs) · [results](summary-discovery-results.json).

## Why ranking was insufficient

The previous change correctly prioritized source records over known derived
summaries in the returned pool. It could not rank an original that discovery
never reached. In an actual CLI process with twenty matching summaries before
an original tool observation, the finite retrieval pages contained only summary
passages. The original was absent from the first model request. The scan was
correctly reported incomplete, with a continuation, but answering required
further archive tool use even though the small source fit within the I/O cap.

The primary source comparison remains Pydantic AI Harness, pinned at
`c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504`. Its
[`SnapshotHistorySource`](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_source.py#L115)
excludes summaries when constructing a durable search corpus. Namzu retains
removed messages and exact summary reads, so this change introduces an optional
source filter and a bounded focused scan instead of deleting that corpus text.
No current upstream performance or equivalent implementation is claimed.

## Algorithm and boundaries

SDK text-source search accepts `excludeDerivedSummaries`, default false. It
skips only the explicit `compaction_shed:summary` source, whose marker comes
from host-owned system-message provenance. It still validates record/index
metadata and observes the same page and I/O limits. It need not load the excluded
body or text manifest. Search cursors bind the selected filter; exact addresses
remain independent of it. Positive `excludedSummaries` counts part visits,
not unique facts or text matches. Unmarked/lookalike messages remain searchable.

The CLI begins with its ordinary general scan. If a partial page includes known
derived summaries, its single refinement scan for that source class uses the
same terms with this filter. Otherwise the existing uncovered-term refinement
continues unchanged. The focused scan spends existing pages, preserves the
general cursor and retains its already-found candidates. Once it finishes,
remaining pages return to the general cursor. There are still at most four
total pages, at most two for the active writer, and an 8 MiB accounted I/O cap.
The host adds no model-facing configuration or tool schema argument.

The focused scan may reach the original while the general scan remains
incomplete. That distinction is retained in context. A summary-only corpus
still supplies candidates and a general continuation; a successful filtered
scan cannot establish absence in the sources it excluded. These are local
retrieval heuristics, not a global ranking or semantic-confidence model.

## Actual CLI comparison

The driver seeds an isolated, scoped closed run containing marked summaries
from the SDK's real summary factory followed by one original observation with
a fresh random receipt UUID. The projected conversation contains none of that
code. The built CLI reopens the conversation through `run --resume` and asks:

> What was the original ORCHID receipt code?

Automatic evidence recall is enabled; project-memory and web recall are off.
Scripted trials replace inference only and inspect the actual request context.
The live trial forwards the provider stream unchanged: `codex/gpt-5.6-luna`,
low effort, four iterations maximum, a 25,000-token ceiling and a 90-second
process timeout. Trials require unchanged archive transcripts, stable relevant
module fingerprints and zero executed tools.

| Trial | Summaries before original | Original in initial request | Context characters | Accounted archive reads | Excluded summary visits |
| --- | ---: | --- | ---: | ---: | ---: |
| Baseline, scripted | 20 | No | 2,821 | 138,903 bytes | 0 |
| Focused discovery, scripted | 20 | Yes | 3,235 | 134,570 bytes | 20 |
| Focused discovery, scripted | 70 | Yes | 2,948 | 223,633 bytes | 70 |
| Focused discovery, live | 70 | Yes | 2,948 | 223,633 bytes | 70 |
| Final rebuild, scripted | 70 | Yes | 2,948 | 223,633 bytes | 70 |

All trials reported incomplete general traversal and retained its continuation.
The seventy-summary case crosses a 64-part index boundary: its first filtered
page is empty but carries a continuation, and the next page reaches the original.
The smaller context in that case reflects different remaining summary candidates
and omission metadata; it is not an intrinsic compression gain. The twenty-case
read reduction is fixture-specific, not a universal performance claim.

The live model returned the exact random code in one request, using 7,613 tokens,
with no tool calls. Its budget ended with 17,387 remaining tokens, zero reserved
tokens, no in-flight requests and no unsettled children. Subscription tokens
were unpriced: zero recorded dollar cost does not mean inference was free.
No baseline live failure is claimed; a model could have followed the baseline's
explicit continuation instead of receiving the original automatically.

Artifacts: `/tmp/namzu-summary-discovery-cli-9QYiIC` (baseline twenty),
`/tmp/namzu-summary-discovery-cli-yVHlDl` (focused twenty),
`/tmp/namzu-summary-discovery-cli-qUDG2Q` (focused seventy),
`/tmp/namzu-summary-discovery-cli-7N84ui` (live seventy),
`/tmp/namzu-summary-discovery-cli-Z8G8Z9` (final rebuilt scripted seventy).
The live trial preceded only the final guard against invalid legacy message
roles. The final build repeated the indexed seventy-summary case with scripted
inference, checked its module fingerprints, and retained the same selection,
context size and accounted reads. It was not another live inference trial.
Reproduce with `node research/conversation-evidence/summary-discovery-cli.mjs`
and optionally `--summaries=70 --live`. The seeds represent historical records;
the driver does not perform seventy model compactions and is not a TUI test.

## Regression coverage and remaining limits

SDK tests cover live/closed/snapshot sources, both inline and large archives,
an empty 64-part filtered page, exact source reads, filter-bound continuation,
ordinary lookalike records and skipped damaged summary bodies whose exact reads
still refuse corruption. Recall validates and reports excluded counts even when
the filtered candidate set is empty. CLI tests exercise active writers, closed
archives and old inline records, preserve general continuation, restore focused
filters through the explicit tool, reject foreign-scope cursors and keep
summary-only fallback. Invalid legacy message roles cannot manufacture summary
identity from the role name; the record is reported unavailable/incomplete.

Validation passed: workspace typecheck, build and tests; SDK 6,552 tests;
CLI 2,927 passed and five skipped; SDK process regressions 264 passed. Lint
passed with 42 SDK, fourteen CLI and one Zen warning, and no errors. Docs conformance and
compiled fences, workflow parity, project references, SDK test presence,
external-name and log audits, and exported-signature checks passed. The final
legacy-role guard was included in the full CLI suite and a subsequent focused
65-test run. These are local checks, not a release or all publish gates.

Enough excluded records can still exhaust the fixed pages before an original
is reached. The focused continuation remains available for that case. This
change does not promise exhaustive discovery, language-independent semantic
retrieval, or globally optimal selection for queries about the summaries
themselves. The first partial page must expose a known summary for this source
refinement to activate; older unmarked summaries are not inferred from text.
