# Stored recording times through conversation recall

Measured 2026-09-12. Baseline: `e954d022`. Updated runs use this change's built
SDK and CLI. [Machine-readable results](recorded-time-results.json) retain the
synthetic observations, first-request passages, usage and before/after hashes
of the five relevant built modules. No user transcript or credential is included.

## Finding and source review

Namzu's disk run writer already stamps each JSONL event inside its append lock,
overriding caller timestamps (`packages/sdk/src/store/run/disk.ts`). Read-back
uses zero for an unknown legacy stamp. Evidence search and exact read validated
those records but discarded their times. Automatic recall could therefore supply
two different observations without the temporal metadata already on disk.

LongMemEval distinguishes temporal reasoning and knowledge updates from ordinary
information extraction. Its time-aware retrieval uses inferred event dates and
query ranges, and reports that inaccurate range inference can harm retrieval.
This change supplies existing recorder metadata; it does not implement the
paper's inference/filtering method or reproduce its benchmark. [LongMemEval,
sections 3 and 5.4](https://arxiv.org/html/2410.10813v2).

The pinned Pydantic AI Harness search implementation ranks text with BM25 and
renders run-local numbered excerpts. Its `_format_message` and `_display_lines`
functions do not add message recording timestamps. That specific renderer is a
useful comparison, not evidence that every Pydantic memory surface lacks temporal
support. [Inspected source, c897c4e8](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py).

Lamport distinguishes causal event order from physical clock values. Accordingly,
Namzu preserves per-run sequence and exposes recording time without using it as
proof of cross-run causality. This is a design constraint drawn from the paper;
no distributed logical-clock algorithm is added here. [Time, Clocks, and the
Ordering of Events in a Distributed System](https://lamport.azurewebsites.net/pubs/time-clocks.pdf).

## Shipped behavior

Search matches, exact read pages and recall candidates have optional `recordedAt`
Unix milliseconds. The SDK derives it from the original validated event, including
spilled tool output, live writer capture and reopened closed-run indexes. CLI
indexed and legacy transcript paths preserve it through search, read and automatic
recall. There is no inferred date from run-start metadata, UUIDs or file times,
and no new index format or per-date source cache.

Missing, zero, negative, noninteger and out-of-Date-range stamps remain unknown.
Custom recall callbacks omit unknown stamps; an explicitly invalid value rejects
the batch. A compaction shed event dates copying, not the original observation.
Each included exact-copy occurrence keeps its own recording time without gaining
another relevance vote. Time metadata consumes the existing context allowance;
omitted-passage addresses remain valid direct archive-read inputs.

Sequence remains authoritative within one run even when the recording clock
regresses. No newest-first ranking or automatic conflict resolution is introduced.
Already visible exact text is still suppressed, including when its original time
is absent from visible context. Explicit search/read is needed for that case.

## Reproducible CLI experiment

[recorded-time-cli.mjs](recorded-time-cli.mjs) uses the built production CLI's
`run --resume` route with isolated temporary state and workspace. The ordinary
history contains only a summary. Two closed synthetic runs each contain a fresh
random receipt code in the text `DELTA receipt last recorded code …`.

Both events have sequence 2. Their recording dates are February 2025 and May 2026.
The text contains no dates. The UUID ordering is fixed, and `--reverse` swaps the
dates between those IDs. Each run's `startedAt` deliberately points to the other
event's date, so run-start metadata is misleading. The current workspace file
contains neither original receipt code. The question is:

> What was the last recorded DELTA receipt code?

A preload observes the actual temporary model context. Scripted controls replace
only inference: they select the highest supplied `recordedAt`, or report that
time is unavailable. The baseline establishes metadata loss, **not a measured
live-model failure**. Live trials forward the provider request unchanged to
Codex `gpt-5.6-luna`, effort `low`. Each trial has a 20,000-token admission budget,
three-iteration ceiling and 90-second process deadline. Automatic recall retains
its existing four-page / 8 MiB read ceiling and opt-in configuration.

| Trial | Recording times reach model | Recall characters | First-pass bytes | Requests / tools | Reported tokens | Outcome |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Baseline, scripted | No | 1,367 | 17,152 | 1 / 0 | 0 | Both texts found; cannot order by missing times |
| Updated, scripted | Yes | 1,429 | 17,496 | 1 / 0 | 0 | Selected later recorded observation |
| Updated, scripted, reversed dates | Yes | 1,429 | 17,496 | 1 / 0 | 0 | Selected opposite run |
| Updated, Luna low, reversed dates | Yes | 1,429 | 17,496 | 1 / 0 | 7,183 | Correct later recorded code |
| Updated, Luna low, original dates | Yes | 1,429 | 17,496 | 1 / 0 | 7,166 | Correct later recorded code |

Both live requests ended normally, made no tool calls and left the workspace file
unchanged. Their combined reported usage was 14,349 tokens. These tokens were
unpriced in the provider accounting; a reported zero monetary cost is not a
claim that the provider charges nothing. The context grew by 62 characters in
this fixture, including changed framing. Measured first-pass read bytes also
increased slightly; no I/O reduction is claimed. All five trials verified stable
built-module hashes throughout their own execution.

Commands from the repository root after building the intended revision:

```sh
# Baseline only, before applying this change:
node research/conversation-evidence/recorded-time-cli.mjs --expect-missing
# Updated, no provider inference:
node research/conversation-evidence/recorded-time-cli.mjs
node research/conversation-evidence/recorded-time-cli.mjs --reverse
# Updated, real small-model requests:
node research/conversation-evidence/recorded-time-cli.mjs --live --reverse
node research/conversation-evidence/recorded-time-cli.mjs --live
```

The script needs the user's installed Codex authentication for live execution;
it neither prints nor copies that credential. Do not rebuild the measured
modules while a trial is running. Each run prints the temporary artifact path.

## Validation and limits

The workspace typecheck, build and tests passed: SDK 6,403 tests; CLI 2,870 passed
and five skipped; other package suites also passed. SDK process tests passed
257 cases in 37 files, including recording times recovered by a new process.
Focused CLI evidence and real Session integration passed 59 cases. Lint passed
with the existing 35 SDK and 14 CLI warnings. Documentation checks, compiled
fences, signature exports (671) and SDK test-presence checks passed.

Added regressions cover live/closed/legacy propagation, reopened caches, full
spills, invalid or missing stamps, compaction-copy time, duplicate timestamps,
writer clock regression, ignored caller timestamps and timestamp-only tampering.
The first focused run failed an existing literal framing assertion after a
capitalization change; that wording was corrected before the successful runs.

This is two live answers over a deliberately small known corpus, not an aggregate
memory score or proof of correct temporal reasoning on arbitrary history. The
trial uses seeded closed records and a replaced history projection, not a new
live compaction experiment. Existing Session and process regressions exercise
compaction/restart mechanics separately. A clock's later value is not a proof of
later truth; missing timestamps, concurrent clocks, temporal details in suppressed
visible text and candidates outside bounded retrieval remain limitations.
No interactive visual TUI change is claimed. Release-only consumer/coverage gates
were not run for this local milestone; nothing was pushed or published.
