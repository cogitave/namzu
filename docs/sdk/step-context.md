---
type: Reference
title: Request-only step context
description: Separate changing observations from system policy and durable operator intent.
resource: packages/sdk/src/types/run/prepare-step.ts
tags: [sdk, context, providers, runtime]
---

# Request-only step context

`PrepareStepResult.context` supplies observations for one model request. The
kernel appends them after the conversation and any step system guidance, in a
user-role message labelled as runtime-generated context rather than a new user
request. Its source is `{ type: 'runtime-context', kind: 'step-context' }`.

This is useful for a current context inventory, retrieved data or other changing
observations that do not require system authority. `system` remains the field
for system guidance; existing callers keep its behavior. A context contribution
does not authorize tools, override policy, or become `latestUserMessage`.

```ts
import type { PrepareStep } from '@namzu/sdk'

export const currentState: PrepareStep = ({ messages, prepared }) => ({
  context: [
    prepared.context,
    `Current visible history contains ${messages.length} messages.`,
  ].filter(Boolean).join('\n\n'),
})
```

Pass the callback as `prepareStep`, or as a stage in its ordered array, to
`query`/`drainQuery`. Later stages see the accumulated `prepared.context` and its
estimated token cost in `contextBudget.remainingTokens`. They may compose it,
replace it, or clear it with an empty string. An omitted field preserves the
preceding stage's decision. Every new step starts without the previous step's
context. Preparation keeps its existing fail-open semantics.

The message is projected into the request, not appended to the run's conversation
history. It therefore does not accumulate, enter a later compaction as an
operator message, or persist as conversation input on resume. A host can record
provider requests separately; request-context digests can still describe its
presence. The runtime provenance must not be presented as text the operator typed.

## Capturing the active invocation

`PrepareStepContext.captureRunEvidence(maxReadBytes?, signal?)` exposes the
same writer-owned boundary used by evidence tools. It is available to both
`prepareStep` and `beforeStep` through their shared context. It returns a
`RunTextEvidenceSource`, or `undefined` when the store does not implement
capture. The optional signal can shorten the run's lifetime for this read;
it cannot keep a cancelled or settled run active. Capture is serialized with
complete durable appends and checks cancellation before and after acquiring
the boundary. It does not accept a path or another run ID.

The [automatic recall step](evidence-recall.md) passes a wrapper of this
capability to its host retriever. Each pass obtains a fresh boundary. A bounded
cursor can continue through a newer snapshot of the same writer, preserving
its original search boundary. After restart, begin a new search. See
[retained tool evidence](retained-tool-evidence.md) for source integrity,
byte/character offsets and the explicit live traversal limits.

## Provider placement and cache limits

A trailing SDK system message does not necessarily stay behind history on the
wire. The OpenAI subscription driver collects system text into `instructions`;
the Anthropic driver collects it into system blocks. A changing inventory in
that slot changes the instructions before the conversation body. Runtime
user-role context stays after history through both conversions, leaving their
system text unchanged when only the inventory changes.

With Anthropic caching enabled, the message cache breakpoint ends before the
first request-only step context. Pending tool results are flushed into history
before that boundary is chosen. It does not mark the changing context or text
after it. Requests without this context retain their previous breakpoint.

This preserves a reusable history prefix; it does not guarantee a cache hit or
reduce total input tokens by itself. Other system contributions, tool schemas,
model routing, history projection and server behavior still affect caching.
Context text consumes tokens and is included in preparation's estimate. The
host must bound its contribution; the field has no independent size cap. No
automatic summarization, output eviction or additional model call is introduced.

The CLI uses this field for its bounded context inventory. It composes preceding
context contributions and leaves system contributions untouched. SDK tests check
stage composition, token estimates, freshness and retained operator intent;
the CLI Session test checks actual OpenAI and Anthropic request bodies with
network transport replaced by a recording fixture.
