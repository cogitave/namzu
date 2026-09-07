# Dynamic context review: Namzu and Pydantic AI Harness

Source audit, 2026-09-07. Initial comparison against Namzu's working tree (HEAD `4a46cb2dc69e896afe55029ce0cd8035a1579c8a`) and local upstream clones. Pydantic AI is pinned to `b61fa91eb75df968b1b6d355d3da8363639408aa`; its separate Harness repository is pinned to `d004ad6a308c0cc88efc7b1b4b3913147e794424`. Recommendations below are engineering inferences, not measured performance claims.

Namzu already has substantial dynamic context machinery. The opportunity is to complete connections between its existing components.

| Area | Already present in Namzu | Actual distinction |
| --- | --- | --- |
| Compaction | Structured summaries, sliding windows, salience selection, pinned material, safe tool pairing, stale-output clearing, overflow reduction, checkpointed working state | Recovering arbitrary original evidence after it leaves the request is less integrated |
| Tool discovery | Ranked deferred-tool search, activation, allowed-tool filtering, five activated matches and near-miss hints | Discovery changes the provider tool array; native deferred-schema revelation is absent |
| Code mode | Opt-in JavaScript batching, nested dispatch, authorization, cancellation, call lineage, bounded print output | Nested calls expose text rather than `ToolResult.data`; the default backend also has a confirmed containment defect |
| Planning | Approval, dependency validation, step outcomes, completion/failure events | No built-in current-plan projection into each request; an appropriate `turn` contribution seam already exists |
| Deferred work | Durable approval parking, checkpoints, resume decisions, completed-tool recovery | These should be extended and tested, not replaced merely to match a framework name |

Pydantic's `StepPersistence` records events, continuable snapshots and a tool-effect ledger; it distinguishes incomplete effects after a crash. This is separate from its Markdown Memory notebook, ConversationSearch, and DBOS workflow execution. Neither its snapshot facility nor Namzu's completed-tool recovery establishes exactly-once external effects: an external action can finish before its receipt becomes durable. Namzu's `runtime/query/resume-pending.ts:349` already avoids replaying completed calls with recorded results. [Pinned StepPersistence source](https://github.com/pydantic/pydantic-ai-harness/blob/d004ad6a308c0cc88efc7b1b4b3913147e794424/pydantic_ai_harness/step_persistence/_capability.py#L49)

## Five actionable improvements

**1. Make original evidence recoverable through scoped handles.** Pydantic pairs compaction receipts with persisted-run handles and offers BM25 conversation search over earlier snapshots. Namzu labels summaries and preserves spill pointers, but has no equivalent built-in arbitrary-history search. Its stale-output editor explicitly says a nonspilled full result is unavailable (`compaction/tool-result-editing.ts:103`). Add a read-only recovery tool backed by immutable original messages/artifacts, with conversation/run authorization, stable IDs, bounded excerpts and explicit missing/expired responses. Emit a compact receipt when information is removed. This is recovery of observations, not proof that their claims remain true. [Receipts](https://github.com/pydantic/pydantic-ai-harness/blob/d004ad6a308c0cc88efc7b1b4b3913147e794424/pydantic_ai_harness/compaction/_receipts.py#L38), [ConversationSearch](https://github.com/pydantic/pydantic-ai-harness/blob/d004ad6a308c0cc88efc7b1b4b3913147e794424/pydantic_ai_harness/conversation_search/_capability.py#L35)

Build an incremental text projection over append-only records, rather than copying Pydantic's snapshot-union scan on every query. Its overflow reader also reads and splits the entire payload before applying line/output limits; local file methods perform synchronous I/O despite their async signatures. Namzu already spills oversized text and gives safer recovery advice than Pydantic's missing-handle suggestion to rerun the tool. Generalize Namzu's local-path spill into an optional artifact-store handle with ranged/streaming retrieval, preserving the prohibition on repeating state-changing actions for their output. Measure bytes read and peak RAM separately from returned tokens. Test cross-scope denial, expiry, restart recovery and retrieval of an exact detail removed by compaction. [Snapshot reconstruction](https://github.com/pydantic/pydantic-ai-harness/blob/d004ad6a308c0cc88efc7b1b4b3913147e794424/pydantic_ai_harness/conversation_search/_source.py#L122), [Overflow reader](https://github.com/pydantic/pydantic-ai-harness/blob/d004ad6a308c0cc88efc7b1b4b3913147e794424/pydantic_ai_harness/tool_output_limits/_capability.py#L614), [Local store](https://github.com/pydantic/pydantic-ai-harness/blob/d004ad6a308c0cc88efc7b1b4b3913147e794424/pydantic_ai_harness/tool_output_limits/_store.py#L111)

**2. Preserve structured data inside bounded code execution.** Pydantic sends serialized tool return values into its interpreter and renders return schemas into its callable catalog. Namzu already authors `outputSchema`, but `tools/builtins/run-code.ts:123` passes only `toolResult.output` to a nested call. Introduce an explicit, compatible result contract so a script can filter structured rows locally without parsing prose. Do not silently switch the existing string return into an object. Add nested-call admission limits, bounded transport/return payloads and memory limits. Persistent interpreter state is optional: it saves repeated transfers but adds lifetime, cancellation and stale-data costs. Test structured filtering with fewer model turns, denied-call fidelity, partial failure, and large returns. [Code-mode serialization](https://github.com/pydantic/pydantic-ai-harness/blob/d004ad6a308c0cc88efc7b1b4b3913147e794424/pydantic_ai_harness/code_mode/_toolset.py#L775)

**3. Keep discovery compatible with provider prompt caches.** Namzu's schema cache already avoids repeated Zod conversion; that does not stop discovery from changing the tools array (`registry/tool/execute.ts:463`). Pydantic separates searchable corpus, hidden status and revealed status; supporting provider adapters preserve stable tool declarations and append discovery records. Extend Namzu's provider-neutral wire contract deliberately, retaining local search as fallback and enforcing authorization at dispatch. Treat provider-native support as a capability, not a universal assumption. Verify request snapshots before/after discovery, compaction rediscovery, denied hidden calls, and actual cache/token metrics when a live evaluation is authorized. [Pinned discovery semantics](https://github.com/pydantic/pydantic-ai/blob/b61fa91eb75df968b1b6d355d3da8363639408aa/pydantic_ai_slim/pydantic_ai/toolsets/_tool_search.py#L1)

**4. Project the current plan into a bounded request tail.** Pydantic reads its current plan each request and appends an ephemeral reminder. Namzu's plan state and approval machinery already exist; use `PromptContributionRegistry`'s `turn` placement (`prompt/contributions.ts:52`, `runtime/query/iteration/index.ts:541`) to display unresolved steps, blockers and recent outcome changes. Keep the authoritative plan outside model prose. Budget this separately and avoid accumulating old reminders in history. Validate that an updated step appears after compaction and resume, the system prefix stays unchanged, and completed tasks do not reappear as pending. [Planning injection](https://github.com/pydantic/pydantic-ai-harness/blob/d004ad6a308c0cc88efc7b1b4b3913147e794424/pydantic_ai_harness/planning/_capability.py#L170)

**5. Add opt-in exact read supersession before summarization.** Pydantic's deterministic read deduplicator requires an application-supplied identity function; no model call is needed. Namzu already clears older outputs and uses salience/deduplication for selection, but lacks this explicit result-supersession rule. Use a stronger identity than path alone: scope, canonical resource, revision and requested range. Never treat a later failed or partial read as a full replacement. Preserve retained evidence and recovery handles. Test repeated full reads, disjoint ranges, revision changes, errors and tool-pair integrity; compare tokens saved and subsequent rereads against the existing editor. [Deduplication source](https://github.com/pydantic/pydantic-ai-harness/blob/d004ad6a308c0cc88efc7b1b4b3913147e794424/pydantic_ai_harness/compaction/_deduplicate_file_reads.py#L32)

## Separate confirmed execution defect

Before expanding code mode, repair its default containment boundary. `execution/code-runtime/types.ts` promises no ambient capability, while `worker.ts` only shadows selected globals inside `new Function`. An authorized, constant-only local probe returned `undefined` for direct `typeof process`, but `object` through the constructor chain; neither invoked a host tool or read environment, files or network. The constant-only reproduction is retained as constructor-escape regressions in `packages/sdk/src/execution/code-runtime/__tests__/quickjs-isolation.proc-test.ts`. This violates the stated contract. A different V8 worker scope does not fix it. Evaluate an actual restricted interpreter or an enforced process sandbox, then test capability denial and resource bounds. The follow-up implementation uses a fresh QuickJS WASM interpreter in each worker, JSON-only transport and explicit resource limits. Real-worker isolation tests and a packed-consumer smoke cover this replacement; see [bounded execution](../../docs/sdk/code-execution.md).


## Implemented follow-up and remaining work

The initial table describes the audited baseline, not missing features in every
later revision. This work added an explicit `toolResultMode: 'structured'` to
`buildRunCodeTool`: successful calls return `{ output, data? }`, while the default
remains text and failures still reject. Eleven real-worker cases check filtering,
falsy values, missing data, denied calls, errors and transport bounds. This
proves the data path, not a measured reduction in real-model task cost.

Compaction now archives original clear/stub bodies before replacing them, including
passes that never write a summary. `RunQuery.shedHistory()` and `fullTranscript()`
can recover that evidence. It still lacks a bounded model-facing history search
and immutable retrieval-handle integration. Structured candidates that do not
reduce estimated tokens are declined. Operator arrivals now update bounded
working state; resumed queued input supersedes older checkpoint intent. Changed
working-memory blocks and selected models invalidate stale prompt measurements.
Selected-model metadata is cached and the runtime rechecks compaction on a model
change. Initial cleanup still precedes preparation, so selecting a larger model
cannot undo an earlier cleanup. Arbitrary ephemeral host text can exceed a window;
the estimator is not a tokenizer or a universal request-fit guarantee.

The source-backed opportunities for native deferred-tool revelation, a bounded
current-plan projection, exact read supersession and indexed original-evidence
recovery remain open. They should be separate scoped implementations, each with
paired request snapshots and behavioral evidence. Adding named brain regions or
an unmeasured graph does not establish improved cognition.

## Real CLI observation

The portable [long-work fixture](long-work/README.md) repairs an actual queue,
then adds cancellation while preserving tenant isolation and attempt accounting.
The original run used `gpt-5.6-luna` at `low`, 16k context and salience compaction.
It made 25 provider requests and reported 255,835 tokens; a 250k observer guard stopped
further generation. The first cancellation instruction arrived as a second turn;
a later correction was consumed during active work. At the stop, visible tests
were 16/17 and private behavior checks 12/15. This was a bounded incomplete result,
not a real provider outage or a completed-task claim.

A conversation resume after the first production fixes made 6 more low-effort
requests and reported 65,139 tokens. Namzu repaired its new visible regression and
reported 17/17 visible tests correctly. It also claimed completion and verification,
while the independent evaluator still passed only 12/15: actual success/failure
receipts were relabelled cancelled and the failure message was lost. Original
files stayed intact. The continuation succeeded as a conversation-history restore;
it is not proof of an exact checkpoint-run retry or exactly-once external effects.

This is a concrete remaining completion-quality gap. The latest cancellation
request was present on the wire; the outcome does not establish compaction as the
cause. A model-authored regression can validate its own mistaken interpretation.
A useful next experiment must separate independently declared task criteria,
current observations and model assertions before accepting completion. The
experimental executive already models this distinction, but the production CLI
does not generally infer or enforce arbitrary natural-language acceptance criteria.
This single task is not a matched before/after experiment or a competitor score.
