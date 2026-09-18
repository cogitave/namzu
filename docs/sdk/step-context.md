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

An SDK evidence-recall failure can contribute a bounded availability note while
remaining an error in diagnostics. This tells the model that automatic recall
was unavailable rather than implying a successful empty search. Only a fixed
status note crosses this internal boundary: raw exception text and rejected
evidence do not. The kernel preserves earlier stage decisions, checks remaining
request room, and adds nothing after cancellation. Other callback exceptions
retain their diagnostic-only behavior. See [evidence recall](evidence-recall.md)
for query-planning, retrieval, timeout and pending-read states.

The message is projected into the request, not appended to the run's conversation
history. It therefore does not accumulate, enter a later compaction as an
operator message, or persist as conversation input on resume. A host can record
provider requests separately; request-context digests can still describe its
presence. A host answer reviewer can inspect the candidate request's transient
context through [`AnswerReviewContext.requestMessages`](verification.md), without
adding it to durable history. The runtime provenance must not be presented as
text the operator typed.

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
automatic summarization or output eviction is introduced by the context field.

The CLI uses this field for its bounded context inventory. It composes preceding
context contributions and leaves system contributions untouched. SDK tests check
stage composition, token estimates, freshness and retained operator intent;
the CLI Session test checks actual OpenAI and Anthropic request bodies with
network transport replaced by a recording fixture.

## Derived work context

After compaction and request projection, the kernel can append two bounded
runtime observations through the same request-only context channel:

- **Visible file evidence:** up to six references to complete built-in `write`
  inputs with unique successful receipts and a matching executor-owned file
  observation fingerprint and execution-owned write-call witness. Transparent
  wrappers preserve the witness through `ToolContext.toolUseId`. The content is referenced, not copied. Missing,
  cleared, truncated, ambiguous or changed evidence produces no entry. Custom
  tools named `write` and trackers without a write-call witness do not establish this contract.
  An entry whose file has since been edited carries `editsInCalls`, the ordered
  built-in `edit` calls applied on top of `bodyInCall`. Each of those hops must
  pass the same visibility checks as the write, the kernel replays them through
  the same apply core the tool ran, and the entry appears only when the replayed
  result matches the ledger's observation fingerprint — which the replay is
  compared against and never sets. A chain is bounded to eight edit calls, and
  one request may replay 262,144 UTF-16 code units of content in total — string
  length, not bytes on disk. A hop is replayed one operation at a time: each
  operation's post-image length is worked out exactly from the body it is about
  to be applied to, compared against what the request has left, and only then
  built — so nothing over the ceiling is materialised, and nothing under it is
  refused for a bound that guessed high. The charge is the largest body the hop
  actually built, which for a batch is the largest intermediate of the fold
  rather than the body it ends on. An operation the ceiling refuses is charged
  nothing, so the paths behind it keep their room. A path over either bound, or with any hop missing,
  cleared, truncated, errored, naming another file or no longer applying, is
  withheld whole rather than in part. An `edit` dispatched by a program or
  another tool rather than by the model carries a nested call id that appears
  in no assistant message, so the hop is invisible and the path is withheld
  until the next full write or content observation — fail-closed by design. A
  tracker without the optional `editChain`/`recordEdit` methods establishes no
  chains and keeps the write-only behavior exactly.
- **A whole-file read's own receipt:** a built-in `read` whose window covered the
  file WHOLE — whether that took no `readRange`, `offset` or `limit` at all, or
  one that still reached every line — witnesses itself in the ledger, and the
  projection emits that call as an entry marked
  `kind: "read"` whose body is the receipt, rendered with every line behind its
  own `N<tab>` prefix. The witness is the fingerprint of what the tool emitted,
  so the entry stands only while the receipt in this request is byte-for-byte
  that: a result the output budget elided or spilled, one compaction cleared, or
  one changed in any other way withholds the path. Nothing recovers a body by
  undoing the numbering. A receipt over 32,000 UTF-16 units is not read at all —
  the same class of bound as the one on a write call's arguments — so a larger
  file is not admitted this way and is read again as it is today. A read roots no
  chain: such an entry never carries `editsInCalls`, and the first `edit` on the
  path withdraws it, because a body that exists only as a rendering is not
  something the kernel may replay onto. Read-rooted entries count against the
  same six paths, and a write-rooted entry keeps a path both could claim. A read
  whose window left any of the file out witnesses nothing, and still advances
  the observation fingerprint for the whole file exactly as before. A tracker
  without the optional
  `readWitness`/`recordFullRead` methods establishes no read entries, and neither
  does a resumed conversation until something reads a file again: the replay
  below rebuilds bodies from `write` and `edit` calls only.
- **Owned delegated work:** `CompletionInbox.describeOwnedWork()` observes up to
  sixteen owned tasks without claiming or draining them. Tasks still running fill
  these slots first, most recently launched first, so a long-running task stays
  named for as long as it keeps running regardless of how many other tasks this
  run has since launched; the most recently settled tasks fill whatever slots
  running tasks leave over. It reports scheduler state, child run status, any
  stop reason and whether the result was delivered to history. Unknown
  scheduler state stays unknown. Other runs' tasks and worker result bodies are
  excluded; an omitted count covers tasks left out entirely, and a running task
  that does not fit is additionally named in the preamble as still running
  rather than folded silently into that count.

These projections distinguish three questions: content visible to this request,
the most recent filesystem observation, and current disk state. Matching the
existing 64-bit observation fingerprint does not perform a fresh read or prove
byte equality against a concurrent writer. The built-in mutation admission
check remains authoritative; a changed file is refused and must be inspected
before replanning. That refusal also withdraws the path's entry: the tool read
the real file in order to refuse, and the projection stops referencing the body
until the ledger's next content observation re-baselines it. Symlink paths that
do not match the ledger's canonical key receive no optimization.

The ledger these entries are checked against is scoped to a conversation, and a
conversation that is resumed rebuilds it by replaying its own restored history
once, before the first request — see
[the observation ledger](tool-execution.md#file-changes-between-observation-and-edit). So a
resumed run's first request can carry entries for files it wrote before the
session closed, and it can carry them only for paths the replay reconstructed
exactly. A path it could not reconstruct is left out of the ledger altogether
rather than entered without a fingerprint, so the read-before-overwrite refusal
still stands over it. A replayed entry is a claim derived from history and is
still checked against the real file at mutation time: a file that moved while the
session was closed is refused there and its entry withdrawn, exactly as a
mid-session change would be. The preamble says so, so the model does not read a
replayed observation as a live one.

None of this duplicates conversation retrieval. `search_conversation` and
`read_conversation`, and the resident [retained tool
evidence](retained-tool-evidence.md) subsystem, are tools the model invokes to
reach content that compaction or a restart has taken out of the request. This
projection invokes nothing and reaches nothing: every entry points at a call
whose arguments or receipt are already in the request being sent, and its whole
effect is that the model does not spend a turn re-reading what is in front of it.
A call that is no longer visible produces no entry rather than a retrieval.

Likewise, a delivered worker result is not a verified answer to the user's
original request. The projection directs the model to incorporate available
results alongside steering unless the operator cancels or changes the request.
It does not infer that a summary was given, impose an extra model call, restart
workers or override cancellation. A delivered result may have left the active
context; its task ID is a retrieval reference, not proof of present visibility.

Each contribution is limited to 8,000 UTF-16 units and an estimated 2,000 tokens.
Preparation's remaining-room estimate must leave at least 1,000 tokens after
admission; below 1,500 tokens both contributions are omitted. Whole contributions
are admitted, never cut references. These are approximate request-room bounds,
not provider billing or tokenizer guarantees. They leave system instructions,
canonical history, tool authority and `latestUserMessage` unchanged. The same
projection is applied to a closing request after an empty completion.

## Bounded preparation inference

`PrepareStepContext.generateText` is an optional experimental capability supplied
by the kernel to each `prepareStep` stage, absent from `beforeStep`. A stage may
await one tool-free inference call; its capability is revoked when that stage
returns. This lets context preparation use the owning run's provider, retry and
fallback chain, token admission and cancellation rather than an unmetered client.
The model is the one selected by preceding stages, with the run's effort setting.

`PreparationTextRequest` contains only `system`, `prompt`, optional `maxTokens`,
`timeoutMs` and `signal`. No conversation, tool definitions, private reasoning or
other request state is implicitly attached. The two input strings together may
contain at most 12,000 UTF-16 units. The output limit defaults to 256 tokens and
cannot exceed 1,024. A caller signal can shorten the stage/run lifetime. These
limits do not guarantee a provider billing ceiling.

`timeoutMs` is accepted and validated and no longer bounds the request. It cannot:
an auxiliary request that ends without its final usage receipt leaves the run's
shared ledger unresolved, and an unresolved request admits nothing further, so a
deadline that fired in normal use did not bound the call — it ended the run that
made it. Against a reasoning model whose auxiliary answer took 17 s, a 10 s
deadline stopped every turn after the first before the model was asked. The call
is bounded instead by the provider's own request timeout and by the run's
cancellation, the same two bounds every other model request in the run has; a
run-level `timeoutMs` on `runConfig` bounds the turn that contains it. The field
is deprecated and will be removed in a later major.

`PreparationTextResult` returns `text` (at most 8,192 units), `usage` and
`servedBy`. Only visible text is collected. Tool calls are rejected without
execution. Oversized or tool-bearing output is discarded while draining the
bounded stream for its usage receipt. Missing usage, invalid inputs and errors
reject; optional-stage failures retain the existing diagnostic and fail-open
behavior. Cancellation with an unresolved receipt remains visible in the token
ledger and can prevent further spending.

Measured auxiliary usage and cost contribute to the owning run and budget. They
are excluded from the main-model `StepResult` counters and do not create a
conversation message or a separate step. Model `maxIterations` counts loop steps,
not these additional provider requests; token budgets still cover both. A host
using the returned text must validate and label it appropriately. In particular,
a query interpretation is neither system policy nor independent evidence.

[Answer reviewers](verification.md#run-owned-review-inference) share this bounded
request/result shape and inference implementation. They receive their own
invocation-scoped capability after a candidate is produced; preparation's
capability cannot be retained for that later phase.
