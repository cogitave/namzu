---
type: Reference
title: The salience-scored working set
description: Deterministic context selection, multimodal token estimates, structural retention and recovery limits.
resource: packages/sdk/src/compaction/plan.ts
tags: [sdk, compaction, memory]
status: stable
---

# The salience-scored working set

The default `salience` strategy scores messages and edits eligible low-scoring
content once the estimated prompt exceeds its soft target (0.5 of the context
window). `structured` retains positional selection and waits for the compaction
trigger. Context planning is pure; the runtime owns provider calls, persistence,
working-memory updates and publishing a successful edit.

## One measurement across decisions

Prompt fullness, retained-tail selection, salience message costs and reclaimed
tokens use one modality-aware estimate. Text and tool-call inputs use the
characters-per-token approximation. An image has a 1,024-token allowance; a
document has 4,096; an already omitted image has 64. Inline and stored
attachments have the same allowance. Base64 length never counts as prose.

These values are heuristics, not billing formulas or upper bounds. Dimensions,
page count, model tokenization and provider processing can change actual cost.
After a provider request, measured prompt usage replaces the estimate for that
submitted prefix. Only messages appended afterward receive an estimated cost.
The tool catalogue is included in the initial prompt estimate.
Changing, inserting or removing the managed working-memory message invalidates
that prefix measurement. An unchanged slot keeps the provider measurement.

A model selected by `prepareStep` uses its own provider-reported window (cached
per model for the run), then the model table/default when unavailable. An explicit
configured window still takes precedence. Changing model invalidates the previous
tokenizer measurement and triggers another compaction check before the request.
Telemetry, advisory pressure and overflow recovery use that selected window.
Preparation runs once, after the initial cleanup; changing to a larger model
cannot undo cleanup already performed against the preceding window. Arbitrary
host-supplied ephemeral instructions are not silently truncated, and estimated
headroom remains a hint rather than a guarantee that every prepared request fits.

Token savings are the difference between estimates before and after an edit.
Encoded character savings remain storage telemetry and do not decide whether
a context overflow was relieved. Forced-overflow recovery requires at least
500 estimated tokens and 2% of the estimated prompt to be shed. Changing image
compression alone cannot turn a failed token-relief check into a successful one.

## Scoring and protection

Each message receives a weighted score from recency, lexical relevance to the
goal, evidence of later use and redundancy. Recency has a 12-message half-life.
Relevance uses BM25 over identifier-aware tokens; textual near-duplicates use
MinHash. Captions participate as text. Rich-content placeholders do not stand
in for image semantics, and rich messages are not demoted as duplicates based
on identical captions or repeated tool inputs.

These are ranking signals, not a proof that a fact is dispensable. Visual
understanding does not happen inside the scorer. A host can retain critical
messages or preserve named tools' results explicitly.

The leading system floor, `retain` boundaries, configured recent messages and
paired call/result boundaries override scores. Recent protection counts
messages, so it is not a guarantee of retaining a fixed number of screenshots.
Candidates are ordered by salience, with larger estimates first among equal
scores. Goal-relevant or subsequently cited candidates have an additional
relative-score protection floor. The policy can stop short of its target.

## Editing and recovery

A clear replaces a tool-result body with a marked head/tail preview; a stub
shortens an assistant narration. Neither operation removes messages or changes
tool-call IDs. Errors and already cleared results are excluded. An edit that
does not reduce estimated tokens is declined. Positional clearing protects the
last three tool results by default and has a 1,000-character-equivalent minimum,
using the same multimodal estimate for eligibility.

A retained spill path survives clearing so the model can read or search the
artifact. Without a saved artifact, the missing full result is explicitly
unavailable. Recovery guidance does not ask the agent to repeat a state-changing
action. Recovering an observation and replaying its action are different operations.

When `recordShedHistory` is enabled, the runtime archives original messages before
publishing a clear, narration stub or summary. Hosts can recover them through
`RunQuery.shedHistory()` and `fullTranscript()`, including clear-only passes.
This archive is separate from an artifact path available to the model; it does
not automatically provide a model-facing history search tool. An archival failure
prevents the edit from replacing live history. Disabling recording forfeits this
recovery path.

If eligible edits cannot relieve pressure, the existing structured-summary path
can run. LLM verification is optional for salience and off by default. Planning
does not promise lossless memory: retained facts, summaries and durable learning
have different lifetimes. Cross-run consolidation remains an explicit host option.

The structured candidate must reduce the same estimated prompt cost before it
replaces history or reports success. Equal or larger candidates report
`shed_nothing`; a useful tool clear staged before that summary can still commit.
Verification may already have run before its candidate is declined. This guard
does not add a cooldown or guarantee the configured target will be reached.

When verification runs, its conversation excerpt preserves visible message text,
tool-call IDs, names and arguments, and each result's ID and reported error flag
in chronological order. Rich tool results retain their text blocks. Image and
document attachments contribute descriptive markers, never their encoded payloads
or storage references; provider-private reasoning is excluded. The verifier does
not inspect the omitted visual or document contents. `convoTextBudget` bounds the
entire excerpt, including labels, separators and its truncation marker. Arguments
and attachment names consume that same budget, so a large earlier value can still
exclude later evidence.

The regression suites in `compaction/__tests__/multimodal-token-estimates.test.ts`
and `runtime/query/iteration/phases/context-measurement.test.ts` cover representation
invariance, provider measurement, token relief and retention. The local salience
eval exercises textual fact retention; it is not a visual benchmark score.
`compaction/__tests__/verifier-excerpt.test.ts` covers the separate bounded text
projection used for verification, including a host-triggered compaction pass.

## Request visibility is separate from retained history

The kernel also projects rich content at the provider-request boundary. A
result can remain in conversation history while an image or document is
omitted from a particular request because of payload limits. Invalid or
provider-rejected images can also be withheld. Retention in history therefore
does not establish availability in the current model input. A budget-only
omission does not delete the original content and can be reversed by a later
request projection that admits it.

Omission markers preserve accompanying action-result text and distinguish
missing observations from actions that failed or never ran. They direct the
model to an available artifact or read-only observation, never to repeat a
state-changing action solely to recover its output. No artifact or recovery
tool is guaranteed to exist. Provider-side context transformations remain
outside the kernel's visibility unless the provider reports them.

File freshness tracking is not an inventory of model-visible content: a
fingerprint does not establish that an earlier read survived compaction,
truncation or request projection. The current runtime does not expose a
unified per-file coverage and visibility inventory. The [request context
inventory](hooks.md#request-context-inventory) tracks exact content blocks at
the SDK provider-input boundary without claiming full-file coverage or freshness.


## Exact repeated observations in the active request

With compaction enabled, `deduplicateObservations` is enabled unless explicitly
`false`. It runs after history compaction and before rich-content projection,
request inventory and the model-call hook, including empty-completion finalization.
It changes provider-bound messages, not canonical history or tool execution.
An SDK run without compaction configuration, or with strategy `disabled`, does
not apply this policy. Set `deduplicateObservations: false` in the SDK compaction
configuration to keep the previous request representation.

For a successful text result of at least 1,024 characters, the kernel requires
an explicitly read-only, non-destructive tool, valid input, identical tool name,
byte-identical argument string and byte-identical output. It keeps the first
full result and substitutes a short reference for subsequent duplicates only
when that reduces estimated tokens. All call/result pairs remain. Errors,
ambiguous IDs, rich blocks, retained messages and `preserveToolResultsFrom`
results are left intact. Unknown or failing tool classification leaves evidence
unchanged. The test is deliberately stricter than semantic equivalence.

References are computed anew from surviving canonical history each request.
If compaction removes or clears the first result, another surviving full copy
becomes the representative. There is no reference to an absent historic copy.
Keeping the first representative also leaves the previous request prefix stable
when another identical observation is appended. This helps preserve cacheable
prefixes; it does not guarantee a provider cache hit.

An identical observation is historical evidence, not a freshness guarantee.
A fresh read still executes, and changed output remains visible in full. A
partial-file result stays partial: equal output does not establish complete-file
coverage or unify different line ranges. No model calls are added by the policy.
This is neither a learned summarizer nor a mechanism for suppressing rereads.
The initial compaction decision still measures history before this projection;
these savings do not guarantee that earlier compaction will be avoided. Provider
serialization, replay and server-side context management can further transform
requests, and token estimates are not billed usage. The request inventory exposes
the resulting SDK-boundary content; compaction counters do not count these
reversible substitutions as history shedding.

## Research basis and validation

[The Complexity Trap (2508.21433v2)](https://arxiv.org/html/2508.21433v2)
compares observation masking and model-generated summaries within SWE-agent on
SWE-bench Verified. Its results support measuring a simple baseline before
adding a summarization model; they do not establish Namzu's task success rate.
[SWE-agent's history processors](https://github.com/SWE-agent/SWE-agent/blob/main/sweagent/agent/history_processors.py)
provide a concrete observation-masking implementation. Namzu's exact-duplicate
policy is narrower than dropping observations by age: a full equivalent result
must remain in the same request.

[AgentFold (2510.24699v1)](https://arxiv.org/html/2510.24699v1)
studies trained agents that manage context at multiple granularities. This
motivates separating durable history from active input; Namzu does not claim to
implement that learned policy or reproduce its benchmark results.
[Anthropic's context-engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
describes just-in-time retrieval and keeping useful context compact. Here,
references identify evidence already present, rather than assuming an external
artifact or retrieval tool exists.

`runtime/query/__tests__/observation-context.test.ts` checks projection savings,
prefix stability, removal and clearing of representatives, distinct file ranges,
retention and mutation exclusions. `observation-context-reaches-provider.test.ts`
runs the real query loop with a scripted provider and real file reads: three
reads execute, an external edit remains visible, and canonical results survive,
with the default policy, explicit opt-out and disabled compaction. These are
correctness and estimated-input checks, not model-quality or billing benchmarks.
