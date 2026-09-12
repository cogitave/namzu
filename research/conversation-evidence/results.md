# Ordinary conversation evidence recovery

Implementation and validation: 2026-09-12. This experiment tests retrieval
through the shipped CLI Session and command boundaries; it is not an autonomy,
reasoning, semantic-memory or competitor-score benchmark.

## Source comparison and design

Inspected the local Pydantic AI Harness checkout at
[`c897c4e8`](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py).
Its conversation search refuses missing conversation identity, filters runs by
that identity, ranks an untruncated rendering with BM25, and displays bounded
windows. `_load_sections` in this file loads the selected runs' histories and
constructs separate search/display renderings. That observation concerns this
method at this revision, not every backend or a claim about current upstream.

Namzu preserves the same useful distinction between retained source and
visible preview. Its existing literal-search contract remains unchanged;
there is no BM25 implementation or semantic-ranking claim here. The SDK now
indexes tool text, assistant completions and textual compaction parts through
one bounded engine. Authenticated chunk filters exclude irrelevant spill
windows, and selected bytes are verified before being returned. Exact
run/event/part identity and optional byte positions connect search to read.

The CLI still authorizes the invoking tenant, workspace project and Session.
It accepts no model-selected history directory. Closed scoped runs use the SDK
index; legacy or active transcripts retain their bounded scan. Contradictory
ownership and altered authenticated output do not silently become ordinary
previews. Retrieval never executes the original action.

## Reproduction

Build first with `pnpm -r build`, then:

```sh
node research/conversation-evidence/cli.mjs
node research/conversation-evidence/cli.mjs --live
```

Each invocation creates a fresh temporary workspace and `NAMZU_HOME`. It
retains a local `result.json` with source fingerprints, synthetic test inputs,
command arguments and observed tool events. No user documents are ingested.
The live mode uses detected Codex credentials without printing or storing
credential values in its report. No installation, push or publication occurs.

Seeding is deterministic: a scripted provider directs the real CLI Session to
read a 400-line synthetic manifest. Two random UUID identifiers occur deep in
that result and outside the 40,000-character preview. The workspace file is
then replaced, and the conversation projection is explicitly replaced with a
summary containing neither identifier. This replacement tests independence
from projected history; it is not presented as an automatic model compactor.

Recovery starts a separate Node process with the production
`namzu run --resume <session>` command. Offline mode substitutes only the
provider via a preload module. Live mode uses `codex/gpt-5.6-luna`, low effort,
at most 10 iterations and a 50,000-token ceiling. The prompt names the receipt,
not its UUIDs or event/byte positions. It asks the agent to search the recorded
conversation and read the original passage without revisiting the changed file.

## Observations

- Deterministic command run: both exact identifiers recovered with one
  `search_conversation` and one `read_conversation`; no workspace reread.
- Live command run: both exact identifiers recovered with the same two tool
  calls, no tool errors and no workspace reread. The first run reported 21,922 tokens; a second run against the final source
  reported 21,761 tokens, again with exactly one search and one read.
  They are subscription tokens unpriced by Namzu's cost ledger; a zero recorded
  monetary cost does not establish that this service is free.
- Search selected an excerpt at UTF-8 byte position 181,304. Read recovered the
  relevant original passage directly; it did not page through the beginning of
  the manifest. Returned `offset` continues to count UTF-16 characters.
- The experiment exposed and fixed missing conversation-tool binding in
  headless resume and a deferred-loading gap for the read tool.

## Deterministic regression coverage

`packages/cli/src/tui/__tests__/conversation-search-reaches-session.test.ts`
executes real CLI Sessions with scripted providers, real read tools and durable
SDK output. The retrieval Session runs actual structured compaction before its
first request; the unknown receipt is absent from that request and recovered
through conversation tools afterward. The test also reconstructs the complete
retained output across pages, checks UTF-16 offsets, rejects changed spill
bytes, rejects conflicting ownership and exercises deferred loading. Separate
cases bind retained callbacks to the executing run when the host switches
conversations and refuse departed or unknown owners.

SDK tests cover all three textual event kinds, more than 64 compaction parts,
unchanged tool-only retrieval, old tool addresses, Unicode chunk boundaries,
source changes, corrupt indexes, preview status and cancellation. Process tests
reopen persistent indexes and old addresses in fresh Node processes. CLI tests
retain legacy-history pagination and cap even JSON-escaped excerpts.

These establish specific recovery and isolation properties. They do not prove
that every model will choose the right query, that all historical claims are
true, or that a live/legacy run without an authenticated retained original can
recover discarded bytes. The index is literal and bounded per call; broad
queries can still require many pages. No embedding-memory, archive-wide
completeness or performance superiority claim follows from this experiment.

The compact [measurements](results.json) retain source fingerprints and separate
offline/live runs. Final validation passed workspace typecheck, build and lint,
all workspace unit tests (including 6,265 SDK and 2,824 CLI tests), 253 SDK
process tests, docs conformance/fences, project references and exported
signature types. This is not a claim that release-only coverage, packaging and
registry gates were run; no package was published.
