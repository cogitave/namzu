# Keeping missing evidence visible across continuation

Measured 2026-09-12 on Linux/WSL. Automatic recall correctly detected an
unavailable retained tool output, but lost that information when handing its
unfinished live scan to `search_conversation`. A later healthy page could then
finish with `incomplete: false`, incorrectly suggesting an exhaustive scan.

## Contract and implementation

The SDK's evidence pages report omissions encountered on that page. Its
[documented consumer](../../docs/sdk/retained-tool-evidence.md) accumulates
`incomplete ||= page.incomplete` while continuing. The CLI's ordinary search
already preserves this scan-level state; its new automatic-to-explicit bridge
incorrectly initialized the same state to `false`.

The bridge now receives the accumulated omissions from its live source:

```text
liveOmitted = liveOmitted OR page.incomplete OR page.unavailable.length > 0
liveRecallIncomplete = liveOmitted OR liveCursor exists
continuation.omitted = liveOmitted
```

An unfinished page allowance and missing source bytes are different states.
Pending pages can be exhausted; a later healthy page cannot restore previously
missing bytes. Deficiencies from a separate closed-history scan must not taint
a healthy live continuation. The change retains one boolean, adds no source
reads or model requests, and changes neither access scope nor the SDK's
per-page contract.

The locally inspected, pinned Pydantic AI Harness
[history source](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_source.py)
selects persisted original messages and materializes its selected corpus.
That implementation does not supply this bounded live-scan omission bridge;
the fix follows Namzu's own paging contract, without claiming a comparative
performance result.

## Production CLI controls

The [reproduction script](omission-cli.mjs) launches the built CLI with an
isolated home and workspace. Real file tools read two oversized files; the SDK
retains their original output. Before automatic recall, a preload changes or
removes only the test-owned retained artifact for one output. The other output
contains ten separated `DELTA` observations. They exceed the automatic live
scan's two-page allowance, so the scripted provider follows the actual emitted
continuation and inspects its terminal page.

| Trial | Earlier unavailable record | Final `incomplete` | Final `unavailableRuns` | Outcome |
| --- | ---: | --- | ---: | --- |
| Previous build, changed spill | 1 | `false` | 0 | Reproduced defect |
| Updated, changed spill | 1 | `true` | 0 | Passed |
| Updated, missing spill | 1 | `true` | 0 | Passed |
| Updated, healthy spill | 0 | `false` | 0 | Passed |

Each terminal page has two remaining matches and no continuation. Every trial
uses exactly two initial workspace reads and one conversation search, finishes
with `end_turn`, and leaves the workspace files unchanged. Module fingerprints
remain stable during each trial. No action was repeated to recover output.

An initial baseline fixture used the full sentence “Search the original DELTA
observations in this conversation.” Its broad automatically selected terms
produced enough additional matches to reach the eight-iteration control limit.
That unsuccessful fixture remains in the JSON results. The later exact `DELTA`
query isolates omission propagation; it does not establish that natural-language
query selection is optimal. That retrieval-quality issue remains separate work.

These are deterministic controls through the production CLI, kernel and stores,
with scripted model decisions and zero billed model requests. They do not claim
new live-model, TUI, compaction, archive-size or throughput coverage.

## Validation

The regression test failed on the previous implementation and passes with the
fix. It uses a real live writer with an explicitly incomplete preview before
ten healthy observations, follows the supplied continuation, and checks that
reusing it also preserves the omission. A separate case verifies a damaged
historical run does not contaminate the healthy live scan. Current-page counts
remain zero when no new omission is encountered.

The accompanying JSON records test and documentation checks. No push or release
was performed; release-only gates are not claimed by this report.
