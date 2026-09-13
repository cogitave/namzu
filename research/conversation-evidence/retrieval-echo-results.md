# Earlier retrieval output must not crowd out its original observations

Measured 2026-09-13. [Reproduction](retrieval-echo-cli.mjs) and
[measurements with built-module hashes](retrieval-echo-results.json).

The automatic recall scorer already groups equal passages. That happens after
bounded candidate discovery. Successful archive-search outputs quote earlier
observations, and many such copies can fill the discovery allowance before a
later correction is visited. Grouping the returned copies cannot recover a
candidate which never reached the scorer.

The baseline was built commit `656e79df`. Intermediate stages and the final
implementation are identified by their captured module hashes. Both baseline
probes intentionally assert that the first context lacks the correction; their
`passed` result means the negative control reproduced, not a successful answer.

## Primary sources and scope

The inspected Pydantic AI Harness implementation at
[`c897c4e8`, `_format_request_part`](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py)
renders a `ToolReturnPart` with its tool name and content. Index formatting keeps
that content, while display formatting limits it to 500 characters. That renderer
does not specially exclude its own successful search responses. This observation
is about the pinned function, not every retrieval configuration in that project.

[LongMemEval](https://arxiv.org/html/2410.10813v2) separates indexing, retrieval and
reading in memory evaluation and includes knowledge-update tasks. Here, that
separation motivates measuring candidate availability separately from the model's
answer. This fixture is not LongMemEval, an implementation of its full protocol,
or evidence of an improved benchmark score. The exact source filter below is a
Namzu engineering choice validated by this local counterexample.

## Fixture and execution

The probe creates an isolated `NAMZU_HOME` and workspace, a real CLI conversation
whose visible history only says that observations were archived, and one scoped
historical JSONL run. That run contains an original random receipt code, 32
successful retrieval copies quoting it, a corrected random code, and another 32
copies of the original. The correction is event 35. The current workspace file
contains neither code. The ordinary model history is checked for leakage, and
the historical transcript must remain byte-for-byte unchanged.

Direct copies are `tool_completed` results. The compaction variant instead seeds
`compaction_shed` records containing paired assistant calls and successful tool
responses. It does not ask a model to produce 64 calls or induce compaction during
this experiment. SDK integration tests separately execute large-archive storage,
live capture, closed/snapshot reads and whole-message restoration.

The actual built CLI runs `run --resume` with automatic evidence recall enabled,
web and memory recall disabled, an isolated trusted workspace, a 90-second process
limit, four iterations and a 25,000-token ceiling. The prompt is:

> What was the last observed ORCHID receipt code?

A preload records the actual request context. In scripted mode it substitutes
only inference, selecting the newest direct `read` passage from that context;
this measures candidate availability, not comprehension. In live mode it forwards
the real provider stream unchanged to Codex `gpt-5.6-luna`, effort `low`.
No build runs during a probe; recorded before/after module hashes must agree.

## Results

| Stage | Inference | Correction in initial context | Retrieval-copy passages | Context characters | Accounted read bytes | Tokens |
|---|---|---:|---:|---:|---:|---:|
| Direct results, baseline | Scripted | No | 1 | 1,946 | 225,398 | 0 |
| Direct results, filter | Scripted | Yes | 0 | 1,808 | 190,478 | 0 |
| Direct results, filter | Live Luna/low | Yes | 0 | 1,808 | 190,478 | 7,338 |
| Compacted copies, before provenance preservation | Scripted | No | 1 | 1,903 | 249,491 | 0 |
| Compacted copies, paired provenance | Scripted | Yes | 0 | 1,808 | 203,988 | 0 |
| Compacted copies, final code | Live Luna/low | Yes | 0 | 1,808 | 203,988 | 7,345 |

Each live run made one model request and returned its fixture's corrected UUID
exactly. Both settled with no pending reservations or unresolved requests. Total
live use across the two probes was 14,683 tokens; the ledger does not establish a
cash price for these subscription requests.

Each filtered first context reports 125 excluded tool-result **visits**, despite
only 64 unique copies. Broad and focused scans revisit sources and account for
those visits again. Every case still reports `incomplete: true` and offers a
continuation: reaching the correction is not exhaustive archive coverage. The
baseline model could have found the correction by explicit continuation; the
scripted baseline tests only initial context selection.

## Implementation and boundaries

SDK evidence sources now accept optional `excludeSuccessfulTools`, bound into
search cursors. The default excludes nothing. CLI automatic recall chooses
`search_conversation` and `read_conversation`; a fresh explicit search remains
unfiltered, and exact reads remain possible even for excluded records. Filtering
happens before payload loading and before candidate limits are consumed, while
record, part, byte, ownership and cancellation bounds still apply.

Known compacted tool names require one correctly ordered call and one result in
the same record, in the immediate result batch. Ambiguous IDs, misplaced results,
missing calls, malformed declarations, or a tool name merely quoted in text do
not establish provenance. Explicit error results and unknown success status are
retained. Large archives written now carry this metadata alongside part manifests;
old archives without it and legacy unindexed compaction messages remain unknown.
Copies retain their compaction source, event sequence and recording time.

Tests cover live, closed and nonterminal snapshot retrieval, normalized cursor
filters, cross-conversation rejection, ordinary searches of omitted copies, exact
readback, error/unknown retention, large compaction restoration and refusal of a
missing excluded manifest when it is explicitly read. Callback exclusion counts
are bounded integers and fit the existing context budget, including exclusion-only
context. The filter is not an authorization mechanism or a claim about truth.

Remaining limits: unknown or differently sourced quotes can still crowd out
candidates; lexical retrieval remains bounded and can miss relevant history;
recording time does not determine truth; correct retrieved text does not guarantee
correct model reasoning. Recall is still opt-in. Two successful live fixtures do
not establish general long-term memory quality.

## Verification

Final workspace typecheck, build, lint and recursive package tests passed. The
SDK suite passed 6,517 tests; CLI passed 2,912 with five skipped; SDK process
regressions passed 264. Existing opt-in/platform tests elsewhere remain skipped;
these are not reported as exercised live-provider coverage. Docs OKF and fence
checks passed, including 47 TypeScript fences and 20 package READMEs. Workflow
parity, project references, SDK test presence, public signature exports, external
names, log standard and publish metadata also passed. No release or registry
publication is claimed by these checks.

## Reproduce

From a built repository, run these individually; `--live` consumes provider quota:

```sh
node research/conversation-evidence/retrieval-echo-cli.mjs
node research/conversation-evidence/retrieval-echo-cli.mjs --compacted-echoes
node research/conversation-evidence/retrieval-echo-cli.mjs --compacted-echoes --live
```

To reproduce the initial miss, use this probe with an isolated, built baseline
checkout and `--expect-missing`. A missing optional module fingerprint is recorded
as `null` for that older build. Each run prints its temporary artifact directory;
no credentials or user conversation history are copied into the report.
