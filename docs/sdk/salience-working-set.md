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

If eligible edits cannot relieve pressure, the existing structured-summary path
can run. LLM verification is optional for salience and off by default. Planning
does not promise lossless memory: retained facts, summaries and durable learning
have different lifetimes. Cross-run consolidation remains an explicit host option.

The regression suites in `compaction/__tests__/multimodal-token-estimates.test.ts`
and `runtime/query/iteration/phases/context-measurement.test.ts` cover representation
invariance, provider measurement, token relief and retention. The local salience
eval exercises textual fact retention; it is not a visual benchmark score.
