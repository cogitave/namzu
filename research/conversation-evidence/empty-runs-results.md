# Bounded discovery across irrelevant runs

Date: 2026-09-12. This is a discovery-round-trip improvement for conversation
evidence, not a general memory score or a claim of lower storage I/O.

## Finding

The CLI returned immediately after every indexed SDK search page, even when the
run was exhausted and had no matches. A 33-run conversation with 32 small
irrelevant runs therefore needed 33 `search_conversation` calls to reach its
original tool observation. Those calls read less than 1 MiB in total. Automatic
recall's four-page allowance also spent its pages on these irrelevant runs.

In the inspected [Pydantic AI Harness source at c897c4e8](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py),
`_load_sections` gathers the selected conversation's histories before ranking
and returning matches. It does not ask the model to traverse each unrelated run.
Namzu retains its own bounded literal scan and authenticated SDK pages, rather
than adopting that whole-corpus ranking/loading strategy. This comparison is
about this method at this revision, not a benchmark against Pydantic.

The CLI now continues after an exhausted indexed run with zero matches. It
still returns control on a matching page or a partial empty page. Every visited
source shares the existing 8 MiB read ceiling, directory batch and output limits;
no extra directory batch is opened in the same call. Unknown I/O after an SDK
exception still charges the remaining allowance and yields. Source ownership,
known omissions and exact-read validation retain their existing checks.

## Measurements

[empty-runs-cli.mjs](empty-runs-cli.mjs) invokes the existing real CLI Session
fixture to read an oversized synthetic manifest once. It verifies that the two
random original identifiers are absent from the visible preview and the
replacement conversation summary, then replaces the workspace file. It adds 32
small scoped closed runs before the observation in UUID discovery order.

Cold and warm searches use real storage, indexing, scopes and pagination without
inference. The subsequent actual CLI command starts a separate Node process and
receives no run ID in its prompt. Scripted mode substitutes only inference;
live mode uses `gpt-5.6-luna`, low effort, at most five iterations, 40,000 tokens
and a 90-second process deadline. No tools may change the workspace.

| Measurement | Search calls until the original observation | Accounted bytes |
|---|---:|---:|
| Baseline, cold index | 33 | 751,826 |
| Baseline, warm index | 33 | 749,287 |
| Changed implementation, cold index | 1 | 751,826 |
| Changed implementation, warm index | 1 | 749,287 |

The same records are still visited. The improvement is removing 32 unnecessary
tool round trips in this fixture; no I/O reduction, archive-wide ranking,
production latency percentile or measured baseline-model token saving follows.

The first live check found the source with one search and returned both correct
identifiers, but guessed byte offset 180900 instead of using the returned 181304.
That offset split a UTF-8 character. The read was correctly refused; the next
read used the exact returned position and succeeded. It spent 31,237 tokens.

The read tool now explicitly asks for the search result's exact byte position,
and its failure message explains how to recover from a guessed position. A real
CLI Session test reproduces the invalid input, checks the guidance seen by the
model, and then reads the original successfully. No silent position adjustment
or weaker source validation was introduced.

The final live check used one search and two successful reads at the two exact
returned positions, recovered both identifiers and made no workspace calls. It
spent 25,779 tokens. The experiment script originally required exactly one read,
which incorrectly rejected this valid two-field recovery. Its original verdict
is preserved, with an independent audit of the retained search addresses and
successful tool results. The script now accepts one or two exact returned
addresses; its final scripted CLI control passed. No additional live request was
made just to repair that assertion. This pair of live trials does not establish
that guidance will prevent every future address mistake.

[Machine-readable results](empty-runs-results.json) preserve the baseline,
intermediate failure, final live trace, independent audit and final scripted
control. Both live runs together measured 57,016 unpriced subscription tokens;
zero recorded monetary cost is not a free-service claim. Built-code fingerprints
were stable during each trial. Original workspace contents remained replaced;
historical retrieval never replayed the original action.

## Verification and limits

Regression coverage includes small irrelevant runs in one call, larger runs
across bounded pages, automatic recall reaching a later source, preserving an
unfinished empty index before a later matching run, and rejecting foreign
ownership without losing omission state. The existing compaction, process-reopen,
changed-artifact, Unicode, cancellation and output-cap tests remain in the suite.

Workspace typecheck/build, lint, all workspace tests, and final CLI tests passed
(SDK 6,429 unchanged; CLI 2,878 passed and five skipped). The final focused search
and CLI Session files passed 66 tests. Docs conformance/fences, log standards and
signature exports passed. SDK process tests were not repeated for this CLI-only
change; the previous SDK commit passed all 258. Release-only coverage, packaging
and registry gates were not run. No push or publish was performed.

Matching-heavy histories, large partial runs, directory continuations and the
fixed automatic-recall allowance can still require more tool calls. The broader
dynamic-context and autonomous-kernel goal remains active.
