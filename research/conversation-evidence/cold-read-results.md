# Durable-address lookup after process restart

Recorded 2026-09-13. Baseline: `c795e3fc`. Machine-readable evidence,
compiled-file fingerprints and exact commands: [cold-read-results.json](cold-read-results.json).

## Problem and change

A durable run/event/part address survives restart, but the CLI's temporary
search location does not. A closed-run read used to return an empty page after
each internal SDK index page, even when ample I/O allowance remained. That
required another model round trip to continue a local lookup. The new regression
failed on the baseline's closed source; the live multipart fixture already
succeeded. The separate live history test crosses multiple captured-writer pages.

The CLI now follows up to eight SDK lookup pages in one read. Every operation
re-resolves the authorized source with the remaining allowance. The existing
8 MiB shared ceiling and conservative 6 MiB reserve for the next SDK operation
remain. Established absence of the requested part, an altered source, wrong
owner or cancellation stays an error rather than a successful read.
A budget boundary, work boundary or stalled cursor
returns a continuation. No source text or authorization is cached by this change.

## Process-level measurement

The reproducer seeds a real CLI Session, calls its manual compaction entry point,
verifies the original user passage is absent from the stored projection, and
closes it. A fresh production `run --resume` process receives only the durable
address and a request to recover the original receipt. Its first tool call is a
read; no search in that process has populated a temporary location. The verifier
requires the original code in a successful, full `compaction_shed:user` read from
the exact maintenance archive. A correct final answer alone does not pass.

The target is textual part 127 in both fixtures. The 127 preceding messages have
900 characters each in the small fixture and 8,100 each in the larger fixture.
Both return the same-size 2,626-character original. Scripted providers isolate
host behavior without token spend; they use the real CLI, stores and tools.

| Fixture | Reads before | Reads after | Accounted bytes before / after | First read after |
| --- | ---: | ---: | ---: | --- |
| Small | 2 | 1 | 504,288 / 504,288 | Exact original |
| Larger | 2 | 2 | 4,161,892 / 4,161,892 | Empty continuation at the byte reserve |

The improvement removes a model round trip for the small fixture; it does not
reduce total disk reads in these measurements. The larger fixture still needs
two calls: the first locates the original, and the next has a fresh read budget.
These are single controlled measurements, not a general latency or model-score
benchmark.

The small fixture also passed with **Codex / gpt-5.6-luna / low**, through the
fresh CLI process: one exact read, no search or workspace action. Usage was
**16,317 tokens**, all unpriced by the local catalogue; zero priced cost is not a
claim of free usage. The experiment had a six-iteration, 45,000-token and
150-second outer limit. Built-file fingerprints stayed unchanged in every run.

```sh
# Scripted CLI restart; original first found through its durable address.
node research/conversation-evidence/manual-compaction-cli.mjs --dense --cold-address --prefix-repeats 100
# Byte-reserve boundary, using the larger default prefix.
node research/conversation-evidence/manual-compaction-cli.mjs --dense --cold-address
# Bounded low-effort live provider verification.
node research/conversation-evidence/manual-compaction-cli.mjs --dense --cold-address --prefix-repeats 100 --live
```

## Validation and limits

- Focused conversation/search/Session suite: 86 passed. Coverage includes expired
  and evicted locations, host shutdown, live-to-closed recovery, multi-page exact
  Unicode text, a missing part, 600-part work-limit continuation, byte-limit
  continuation, decreasing live-operation budgets, ownership rechecks and
  cancellation between pages.
- Workspace typecheck, lint and tests passed. SDK: 6,447 tests; CLI: 2,899 passed,
  five skipped. Lint retained 37 SDK and 14 CLI warnings, with no lint errors.
  The first typecheck caught an optional-source assumption in a new test helper;
  it was corrected before the successful run.
- Workspace build, docs conformance and fences, signature-export audit, log and
  external-name tests/audits passed. SDK process tests were not rerun for this
  CLI-only implementation. No claim that every release gate or platform passed.

Eight lookup pages bound work even when index records are tiny. Empty pages
remain legitimate at the configured work/byte boundaries, and callers must
follow their continuation. This improves recovery of a known historical address;
it does not prove archive-wide semantic recall, current file freshness, or
autonomous completion of unrelated tasks.
