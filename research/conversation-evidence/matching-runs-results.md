# Pack matching runs into bounded conversation-search pages

2026-09-13. Explicit literal searches returned as soon as an indexed run
matched, even when that run was completely searched and the public page still
had capacity. Automatic multi-term discovery could already cross completed
matching runs. A history with several small matching announcements therefore
made explicit recovery spend one model/tool round trip per announcement.

The CLI now continues to the next run after a fully consumed SDK page. It
still yields immediately for a partial SDK page, preserves source omissions,
and bounds discovery to one directory page, reads to 8 MiB, and serialized
matches to 12,000 bytes. No source is skipped to reach a later match.

Before each indexed search, the host asks for at most:

```text
min(3, requested_limit - returned_matches,
    floor((12000 - serialized_match_bytes) / 4000))
```

The 4,000-byte reservation covers an excerpt's 512 UTF-16 units, worst-case
JSON escaping, bounded source metadata and separators. Actual serialized
sizes are charged afterward. The reservation adjusts the SDK's match limit
**before** it consumes a record; it does not discard already consumed results
to fit the output page. Exact reads and source addresses are unchanged.

## Primary-source comparison

[Pydantic AI Harness conversation search](https://raw.githubusercontent.com/pydantic/pydantic-ai-harness/main/pydantic_ai_harness/conversation_search/_toolset.py)
collects documents from the selected runs, ranks across that scoped corpus,
and keeps displayed context windows within each result's run. This is a useful
distinction: a result belongs to one run, but a response need not stop at that
run's boundary. Namzu retains its bounded, incremental traversal; this change
does not adopt corpus-wide ranking or increase scan allowances.

## Storage and process measurements

`matching-runs-cli.mjs` invokes the existing real CLI Session seed. The actual
`read` tool reads a large synthetic manifest once. Its random tracking and
destination identifiers are confirmed absent from the visible clipped result
and replacement conversation projection. The workspace file is then replaced.
Six small, explicitly scoped closed runs are inserted before the original in
UUID discovery order. They mention DELTA but only announce an intention to
find the receipt; they contain no original identifiers.

`--baseline` ran against the prior built search implementation. After building
the change, the same fixture construction ran again. Each case has independent
random identifiers and session IDs. Cold and warm passes within one case use
that case's same archive. Searches stop when the original retained observation
is reached; this is not a full-corpus completion measurement.

| Default-limit discovery | Calls to reach original observation | Accounted read bytes |
| --- | ---: | ---: |
| Prior implementation, cold | 7 | 711,300 |
| Prior implementation, warm | 7 | 676,626 |
| Packed pages, cold | 2 | 480,993 |
| Packed pages, warm | 2 | 446,319 |

The previous pages held `[1,1,1,1,1,1,2]` matches; the changed pages held
`[5,3]`. The latter target scan requested fewer matches because earlier runs
had used part of the public page's allowance. It stopped sooner inside the
large source while still finding both identifiers. Thus the byte counts
describe work **until discovery**, not equivalent exhaustive coverage or an
archive-wide I/O reduction. An exact read independently recovered the original
tracking code in each storage pass. Build fingerprints remained stable during
each measurement and distinguish the baseline from the changed implementation.

## Live CLI and actual TUI

`--live` launched the built CLI in a separate process with `run --resume`,
`gpt-5.6-luna`, `low` effort, at most six iterations, a 40,000-token admission
allowance and a 120-second process deadline. The prompt requested historical
identifiers and exact retained text without workspace or external operations.

The model requested `limit: 20`. One search returned eight matches from seven
runs; two reads used the exact addresses and byte offsets returned by search.
Both original identifiers were correct, all tools succeeded, and no workspace
read, shell or mutation was called. The current file stayed replaced. Reported
usage was **28,402 unpriced subscription tokens**; a recorded zero dollar total
is not a free-service claim. This is one successful example, not an accuracy
rate or a measured before/after model-token saving.

`matching-runs-tui-fixture.mjs` then resumed the seeded conversation in a real
100-column, 28-row PTY. It replaces only inference with a scripted transport.
Actual archive tools used the default five-match limit: two searches and one
exact read recovered both identifiers. The provider boundary asserted page
limits and source text; the composer returned idle and `/exit` exited zero.
Twelve original source/workspace files kept identical SHA-256 hashes.
Installed `@xterm/headless` replayed the captured ANSI to inspect the final
screen. This TUI check used no live inference tokens.

`matching-runs-results.json` retains the individual pages, exact CLI calls,
returned output, usage, fingerprints and terminal trace. Old research replays
that require the previous page boundary may now refuse a missing continuation;
that is an appropriate setup failure before live inference, not a reason to
recreate obsolete cursor behavior in production.

## Verification and remaining limits

Focused coverage includes literal and multi-term escaped output across runs,
limit continuation without lost/duplicate matches, exact reads from later
pages, partial indexes before later matches, nonmatching runs, foreign scope,
altered sources, cancellation and directory pagination. Ninety-two focused
tests passed. The expected second page of one partial-index test now contains
both the final match from that index and the following run; its first partial
page still yields and no index position is skipped.

Workspace typecheck, lint, tests and build passed. The SDK passed 6,684 tests;
the CLI passed 2,959 with five skipped. Documentation conformance and 48
TypeScript fences plus package README fences passed. Existing lint warnings
remain. These are local checks, not all release gates or a published version.

This removes an avoidable run-boundary round trip. Larger partial records,
directory continuations, exhausted byte allowances and model-selected searches
can still require additional calls. Retrieval completeness is not a factual
verdict, and the broader dynamic-context goal remains active.
