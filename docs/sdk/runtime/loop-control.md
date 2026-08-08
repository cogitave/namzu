---
title: Loop Control and Resilience
description: Stop conditions, step records, provider retry, budgets across resume, compaction triggers and outcomes, and extended thinking and effort in the @namzu/sdk agent loop.
last_updated: 2026-08-05
status: current
related_packages: ["@namzu/sdk", "@namzu/anthropic"]
---

# Loop Control and Resilience

`query()` runs the agent loop. This page covers the seams for controlling
when it stops, seeing what it did, and surviving the things that go wrong.

## 1. Stopping the Loop

The loop ends naturally when the model stops calling tools. Everything
else is a policy you supply.

### Programmable stop conditions

```ts
import { query, hasToolCall, stepCountIs, anyOf } from '@namzu/sdk'

query({
  // …
  stopWhen: anyOf(hasToolCall('submit_answer'), stepCountIs(20)),
})
```

`stopWhen` is evaluated **after** each step's tools have run, so a
predicate sees what they returned. That ordering is what lets a terminal
tool end the run *after* executing rather than instead of executing — its
output is still recorded and still reaches the model's history.

| Helper | Fires when |
| --- | --- |
| `stepCountIs(n)` | `n` steps have completed |
| `hasToolCall(...names)` | the latest step called any of `names` |
| `anyOf(...conditions)` | any condition fires (short-circuits) |

Conditions may be async. A condition that throws is logged and treated as
"do not stop" — a caller's bad predicate must not be able to kill a run
the real budgets would have let finish.

The run settles with `stopReason: 'stop_condition'`.

### Judging the answer, not just the tool calls

`stopWhen` is evaluated after each step's **tools** have run, so it has
nothing to say at the moment the model stops calling them — the run simply
finalized with whatever it had produced. Verify-then-fix (run the build,
feed the failure back, let it try again) meant starting a whole new run and
re-supplying the context the first one had already assembled.

```ts
query({
  reviewAnswer: async (answer, { messages }) => {
    const build = await runBuild()
    return build.ok
      ? { accept: true }
      : { accept: false, feedback: `The build fails:\n${build.output}` }
  },
  maxAnswerReviews: 3,
})
```

The feedback is pushed as the next **user** turn, because the model is the
audience — a code would have to be explained to it anyway. Say what is
wrong and what would satisfy the check.

Three properties are load-bearing:

- **Bounded.** `maxAnswerReviews` (default 3) caps rejections. Past it the
  run stops with `stopReason: 'answer_rejected'` — a reason that names the
  reviewer rather than the resource it exhausted. Without a distinct
  reason, a reviewer that never accepts would end the run on
  `max_iterations` and send the reader looking for a loop.
- **Never on the forced-final turn.** That turn exists to extract a closing
  summary under pressure; rejecting it would spend budget the run has
  already run out of.
- **A reviewer that throws ACCEPTS.** This is the opposite of what the
  safety gates do, deliberately. They are asked "is this dangerous", where
  failing closed costs one refused operation. This is asked "is this good
  enough", where failing closed means handing the answer back forever — so
  a broken judge would turn every run into a loop. One unreviewed answer is
  the cheaper failure. The throw is logged at `error` so it is never
  mistaken for approval.

### Numeric budgets

`AgentRunConfig` carries `tokenBudget`, `costLimitUsd`, `timeoutMs` and
`maxIterations`. These are the backstop, not the primary control: they
answer "this has gone on too long", never "the work is done".

`costLimitUsd` requires a `pricing` table on `query()`. Without one, cost
stays at zero and the limit never trips.

## 2. Seeing What the Loop Did

`Run.steps` carries one `StepResult` per iteration, and `onStepFinish`
fires as each completes.

```ts
query({
  // …
  onStepFinish: (step) => {
    console.log(step.stepNumber, step.usage.totalTokens, step.durationMs)
  },
})
```

| Field | |
| --- | --- |
| `stepNumber`, `model`, `messageId` | identity |
| `servedBy` | which provider and model actually answered |
| `content`, `toolCalls`, `toolResults` | what happened |
| `finishReason` | why the turn ended |
| `usage`, `costDelta` | **this step's** consumption, not the running total |
| `startedAt`, `durationMs`, `toolExecutionMs` | timing, split by phase |

`toolResults` is ordered by the tool *calls*, so it lines up with
`toolCalls` index for index.

### What was asked for, and what answered

`model` is the model the step **asked for** — the run's configured model, or
the override a [`prepareStep`](#5-shaping-each-step) hook returned for this
step. `servedBy` is who answered it:

```ts
step.model    // 'primary-model' — what the step asked for
step.servedBy // { providerId: 'fallback-provider', model: 'fallback-model', chainIndex: 1 }
```

They are equal on every run without a provider chain. They diverge when a
chain falls over ([CLI chain
docs](../../cli/providers.md#the-provider-chain)): the request goes to the next
member, and `servedBy.chainIndex`
is that member's position in the chain you declared — `0` is the head. The index
is there because a chain may name the same provider twice with two models, and
`providerId` alone could not tell those apart.

At run level, `run.metadata.provider` stays the provider you **configured** and
`run.metadata.servingProvider` names the member the run was routed to at the
end, absent when the configured one served throughout.

Two limits worth knowing before you build on this:

- **Only tool-calling turns are recorded.** The turn that produces the final
  answer ends the loop before a step is written, so it is not in `steps`. On a
  chain that falls over and answers immediately, `run.metadata.servingProvider`
  is the only record of the swap.
- **The built-in store writes `metadata`, not `steps`.** `run.json` carries
  `servingProvider`; per-step provenance reaches you on the returned `Run`, so
  persist that if you need it.

## 3. Transient Provider Failures

Model calls are retried by default with exponential backoff and full
jitter, honouring a server-sent `Retry-After`.

```ts
query({
  // …
  retry: { maxRetries: 5, initialDelayMs: 1_000 }, // or `false` to opt out
})
```

Only failures **before the first content chunk** are retried. Once a delta
has been yielded the consumer has already emitted `text_delta` events and
cannot un-emit them, so a mid-stream failure is surfaced rather than
replayed.

Failures are classified into `ProviderError` with a `code`, a `retryable`
flag, the HTTP `status` and a parsed `retryAfterMs`:

| Code | Retried |
| --- | --- |
| `rate_limit`, `overloaded`, `server_error`, `timeout`, `network` | yes |
| `auth`, `invalid_request`, `not_found`, `content_filter` | no |
| `context_length_exceeded` | no — the prompt must shrink first |

`context_length_exceeded` is deliberately separate from the generic 400:
it is the one 4xx a caller can act on.

### A wait longer than your ceiling is refused, not shortened

`maxRetryAfterMs` (60s by default) is the longest server-directed wait the
loop will sleep. A `Retry-After` **at or under** it is slept exactly as
instructed. Past it, the error is surfaced with `retryAfterMs` intact and the
decision is yours:

```ts
// The provider said "come back in 15 minutes". You get the error, now,
// carrying 900_000 — schedule against it, or raise the ceiling.
retry: { maxRetryAfterMs: 60_000 }
```

It used to fall through to the ordinary jittered backoff instead, so a provider
asking for fifteen minutes was re-asked in half a second and the remaining
attempts were spent on an endpoint that had already said no. Nothing settles
differently: the error thrown is the one the exhausted path throws, so a run
that used to fail after four attempts now fails after one.

If you declare a [provider chain](../../cli/providers.md#the-provider-chain)
this is where it pays. A rate limit is a fact about the *member*, so the chain
advances to the next one immediately rather than after the budget is gone.

Aborts propagate untouched, so a Stop still settles the run as
`cancelled` rather than being mistaken for a transport failure.

Each backoff emits `provider_retry` **before** it sleeps, carrying the
attempt, the delay, and the classified code — so a host can tell a run that
is waiting from a run that has hung.

### When a transient failure survives every retry

The run settles as **paused**, not failed: `run_paused` names the
checkpoint to resume from, and `Run.stopReason` is `'paused'`. A 503 and a
bad API key used to be indistinguishable at the run boundary, so recovering
meant the host knowing about checkpoints and driving replay itself.

Both conditions are required — the failure must classify as `retryable`
**and** a checkpoint must exist. Pausing on a permanent error would invite
a resume that cannot work; pausing with nowhere to resume from produces a
run nobody can pick up again, which is strictly worse than reporting the
failure.

When a run does fail, `run_failed` carries `failure` (the structured
classification) and, when a catalog rule claims it, `explanation` — a
stable id and a sentence saying what to change. See
[Event Bridges](../integrations/event-bridges.md).

### Relief when the prompt is already too long

`context_length_exceeded` triggers a forced compaction pass and one retry.
Two rules keep that from spinning or giving up early:

- The retry only happens if the pass shed a **meaningful** amount — a
  fraction of the prompt, floored at a couple of thousand characters. Any
  positive shed used to count, so clearing one short tool result reported
  success and the retry burned a call to be told the same thing.
- Relief is latched per **stuck point**, not per run. The latch stops a
  second overflow immediately after a successful compaction from looping;
  it is cleared by a turn that actually succeeded. As a run-scoped flag it
  meant one relief at iteration 3 left iteration 40 to die on an overflow
  with obvious moves left.

## 4. Budgets Across a Resume

`query({ resumeFromCheckpoint })` restores `tokenUsage`, `costInfo`,
the iteration count **and elapsed wall-clock** from the checkpoint. A run
recalled at $4.80 of a $5 cap continues from $4.80; it does not get a
fresh envelope.

Side-channel model calls — advisory consultations, the compaction
verifier, agent routing — are counted against the same budgets.

## 5. Shaping Each Step

`stopWhen` decides whether to keep going. `prepareStep` decides *how* the
next step should look — the other half of the same idea.

```ts
query({
  prepareStep: ({ stepNumber, steps, messages }) => {
    if (stepNumber <= 3) return { activeTools: ['search', 'read_file'] }
    return { activeTools: ['write_file'], model: 'claude-haiku-4-5-20251001' }
  },
})
```

The hook receives the run id, the step number, the full message history
and every completed `StepResult`. It may return `activeTools`, `toolChoice`,
`skills`, `model`, `system`, `temperature` and `maxResponseTokens`; an omitted
field keeps the run's configured value, and returning nothing is the same as
having no hook.

`toolChoice` is the one that *forces* rather than narrows — `'required'`,
`'none'`, or a named function. It lives here rather than on the run config by
construction: a forced choice that persisted would make the model call a tool,
see the result, and be forced again, which is an agent that cannot stop. Each
step is prepared fresh, so the force cannot outlive the step that asked for it.
It also costs more cache than `activeTools`, because moving `tool_choice`
invalidates cached message blocks and not only the tool prefix.

Without it the tool surface and the model are fixed at `query()` time, so
a phased agent — research, then write, then verify with a cheaper model —
had to be several separate runs, each starting blind to the last one's
context.

### `activeTools` narrows the kitchen, not only the menu

A tool outside the list is **refused when it is called**, not merely left out
of the request. The same holds for run-level `allowedTools`, which makes the
same promise for a whole run.

That distinction is the whole value of the field. Deciding which schemas go
into the request is a statement about the *menu*; a model names a tool it was
not offered more often than it sounds — whenever it repeats a call from earlier
in the context, whenever a gateway carries its own tool list, and whenever a
cached prompt prefix is replayed. A host using this to fence a step, which is
the obvious use and the one the type invites, wants the fence to hold on the
execution path too.

The refusal is an ordinary `tool_result` naming what *is* available, so the
model can route around it and the turn continues.

Two details that decide behaviour:

- **Absent is not empty.** No list means no restriction; an empty list means the
  step may call nothing. Reading an empty allow-list as "unrestricted" is a
  fail-open, and it is one this runtime has already been bitten by once in the
  delegate roster.
- **A step's list beats the run's**, matching the precedence the request already
  used, so the two cannot disagree.

Four more things worth knowing:

- **`system` is one-step guidance.** It is appended to the *request* and
  never pushed onto the run's history, so a long run does not accumulate
  one stale phase instruction per iteration.
- **`activeTools` costs a prompt-cache prefix.** Tools render at position
  0, so changing the set invalidates the cached prefix for that step. That
  is inherent to narrowing — worth paying at a real phase boundary, not
  every step.
- **It does not touch `tool_choice`.** The wires namzu speaks have no
  `allowed_tools` parameter, and moving `tool_choice` invalidates cached
  *message* blocks as well: a strictly worse trade for the same effect.
- **The hook fails open; the list does not.** A throwing hook leaves the step
  with the run's configuration. A list the hook *returned* is enforced, and
  names that are not registered are dropped from it with a warning.

  **Dropping every name leaves the step able to call nothing, and that is
  deliberate.** The list means *only these*: if a rename outlives a phase list,
  the only set satisfying "only the tools that no longer exist" is the empty
  one. Widening back to the run's list would grant precisely the tools the
  caller excluded, on the grounds that their own list failed — a step that can
  call nothing is constrained, while a step that can call everything is a
  control that stopped applying. The step is constrained, not crashed: the model
  answers from what it has and the run continues.

  The warning is the part to watch. It goes to the logger, and it distinguishes
  some-names-dropped from all-names-dropped because those have different
  consequences — but a host that silences its logger sees a phase quietly stop
  doing anything.

### More than one concern

A single slot is enough for one concern and no help with two. Pass an
array and each stage runs in **declaration order**, seeing what the ones
before it decided:

```ts
query({
  prepareStep: [
    ({ runId }) => ({ system: tenantPrefixFor(runId) }),
    ({ steps, prepared }) =>
      spend(steps) > budget && prepared.model === undefined
        ? { model: 'cheaper-model' }
        : {},
  ],
})
```

Declaration order, not registration order — that distinction is why this
is safe where a plugin-style fan-out would not be. The author writes the
order down, so "who wins" is a line of their code rather than an accident
of install history. A later stage overriding a field is last-writer-wins,
visibly; `context.prepared` is how an earlier decision gets refined
rather than guessed at, and it is empty for the first stage.

A stage that throws is skipped and **the rest still run**: one broken
concern must not silently disable the others it was declared beside. A
single function still works exactly as before.

## 6. Context Compaction

Compaction triggers on **window pressure**, measured against the model's
context window:

1. `compactionConfig.contextWindowTokens` if you set it,
2. otherwise resolved from `runConfig.model`,
3. otherwise a conservative 128k default.

`tokenBudget` is never the divisor — it is a cumulative spend cap, a
different quantity, and comparing a live context against it is
self-defeating.

Context size prefers the provider's reported `promptTokens` from the last
turn over a character heuristic, because it counts what the heuristic
cannot see: tool schemas, system blocks, image tokens, per-message
framing.

That measurement describes the prompt as it was **sent**, so everything the
turn appended afterwards — the assistant message and every one of its tool
results — falls outside it. The reported number therefore has an estimate
of that tail added to it. Reading it verbatim made the trigger one full
turn stale, and the staleness is largest on exactly the turns that add the
most: a turn returning 200 KB of tool output counted as if it had returned
nothing. The character-heuristic fallback (used before any turn has
reported, and for providers that return no usage) now includes the tool
catalogue too — a 30-tool registry is easily 10-20k tokens of JSON Schema
that shipped with every request and entered no estimate at all. Both
omissions biased the same way, under-count, so the trigger did not jitter
around the threshold; it sat systematically late.

### Clearing stale tool output first

Before summarizing, the pass clears the **output** of old, large tool
results in place — replacing it with a short placeholder naming the tool
and its original size. If that gets the context back under
`triggerThreshold`, summarization is skipped entirely and the history stays
verbatim.

That shortcut does **not** apply to a forced pass. A forced pass runs
because the provider rejected the prompt as too long, which is a
measurement — and the shortcut would answer it with the same estimate the
provider just refuted, declare success after clearing one result, and hand
back a history that overflows again on the retry.

The ordering is the point. Summarization paraphrases away the agent's own
reasoning — the decisions, the false starts it learned from, the exact
wording of a plan — and that is a heavy price for a context problem usually
caused by something much dumber: a handful of enormous tool outputs the
agent already read and moved past. Clearing them is also *safe* where
trimming is not, because nothing moves: the `tool` message keeps its
position and its `toolCallId`, so `tool_use` ↔ `tool_result` pairing holds
by construction.

| Field | Default | Meaning |
|---|---|---|
| `clearToolResults` | `true` | Set `false` to go straight to summarization. |
| `keepRecentToolResults` | `3` | Most recent results left alone — still in use. |
| `minToolResultCharsToClear` | `1000` | Below this the placeholder costs as much. |
| `preserveToolResultsFrom` | — | Tool names never cleared. |

Never cleared: an **error** result (small, and it is what steers the next
turn), the most recent N, and anything under the size floor. Image payloads
are measured by their base64 size — a screenshot is the largest thing a
tool result can carry and exactly the kind of output an agent reads once.

### Pinning a message against eviction

Set `retain: true` on a message and neither the summarization rebuild nor
the in-place clearing pass will touch it:

```ts
query({
  messages: [
    { role: 'user', content: 'the account id is 4471; never bill a different one', retain: true },
    { role: 'user', content: 'draft the invoice' },
  ],
})
```

Everything else the run protects is protected by **position** — the
leading system messages, the working-memory slot, the last N turns, the
most recent tool results. A standing constraint stated in the middle of a
conversation therefore aged out at the same rate as chatter, and no
positional rule could express it. The working-memory slot cannot either:
it is host-rendered each turn and does not know what the user said.

Protection is transitive across a tool pair. Pinning a `tool_result` also
pins the assistant turn that issued the call, and pinning that turn pins
every result answering it — half a pair is not a smaller history, it is
one the provider rejects.

Pinned turns survive verbatim, in order, between the summary and the
recent window. They are also described by the summary, which is the point
rather than a waste: a paraphrase is what the pin exists to refuse.

Nothing caps how much you may pin. Pinned turns are exempt from the
reclaim that keeps a long run alive, so pinning the whole transcript makes
compaction useless — a cap would have to guess which pin mattered, and
dropping the wrong one quietly is worse than a run that overflows in the
open.

### Both outcomes reach the run

A pass that shed history emits `compaction_completed` (wire:
`compaction.completed`) with before/after message counts and token sizes.
Compaction deletes history irrecoverably, so it is worth surfacing — and it is
emitted from **both** strategies, the structured working-state path and the
reducer path a host takes with its own `contextReducer` or with
`strategy: 'sliding-window'`.

A pass that shed **nothing** emits `compaction_failed` (wire:
`compaction.failed`). A shed that did not happen is exactly as consequential as
one that did: the run carries on at full context toward a provider rejection
several turns later that will name none of this. A log line is not enough to
carry that, because a host that silences its logger — which every command-line
entry point does — makes the decline invisible to the user, to the host *and* to
the model at once.

The event carries a `cause`, because the three declines want different
responses:

| `cause` | What happened | What it means for the next pass |
| --- | --- | --- |
| `reducer_threw` | the reducer raised | usually a bug, or a failed model call inside a summarizing reducer — the next pass may work |
| `shed_nothing` | it returned no fewer messages than it was given | history is at its floor, or the reducer's threshold disagrees with the trigger's — every later pass declines identically |
| `split_tool_pair` | its result separated a `tool_use` from its `tool_result` | a reducer bug; the result was refused wholesale rather than sent to a provider that rejects the pairing |

It also carries the unchanged `messages` count, and `error` for
`reducer_threw` only. **The history is guaranteed untouched on all three** — a
reducer's result is installed whole or not at all — so there is no partial state
to repair and reporting is the whole remedy.

If you switch exhaustively over `RunEvent`, `compaction_failed` needs a case. A
host that ignores unknown events is unaffected. Neither compaction event is
forwarded over the A2A bridge: a peer models a task lifecycle and cannot act on
how this runtime manages its own context.

### How full the context is, between passes

Compaction events tell you when history was shed. `token_usage_updated` tells
you how much room there is the rest of the time:

| Field | Is |
| --- | --- |
| `contextTokens` | the size of the conversation being sent **right now** — it falls when a compaction sheds |
| `contextWindowTokens` | the ceiling that size is measured against |
| `contextMeasuredBy` | `provider` if the prompt was counted, `estimate` if it was not |
| `windowSource` | `config`, `model-table` or `default` |

**These are a different quantity from the `usage` beside them, and the naming is
deliberate because confusing the two is a category error this estate shipped.**
`usage` is *cumulative spend*: prompt plus completion tokens summed across every
turn, monotonically increasing, and untouched by compaction. Dividing it by a
context window produces an indicator that climbs toward full on any long run no
matter how much room the conversation actually has — most wrong precisely on the
runs where someone is watching it. `contextTokens` is the numerator that
question wants.

Both provenance fields exist because **a fraction is only as honest as the
weaker of its two numbers.** A surface rendering these owes its reader the same
distinction rather than presenting an estimate as a measurement.

All four are **absent when the run has no compaction configuration** — nothing
then resolves a window, and inventing one would be the guess these fields exist
to replace. `measureContext` is exported for a host that wants to compute the
same figure itself.

## 6b. What a Finished Run Leaves Behind

```ts
query({
  compactionConfig: { strategy: 'structured' },
  promoteMemory: async (candidate) => {
    for (const requirement of candidate.userRequirements) {
      await memoryStore.create({ title: candidate.task, summary: requirement, content: requirement })
    }
  },
})
```

The SDK could **store** a memory and could not **form** one: `MemoryStore`
and its disk implementation have been here all along, and the only path
into them was the model calling `save_memory`. A run that worked out a
durable fact and never thought to write it down lost it at settle — along
with everything the compaction pass had already extracted and structured
on the way.

The extraction is the part that was already built. Compaction distils the
transcript into decisions, discoveries, requirements and failures
precisely because a list of facts is worth more than a summary of prose;
that structure was serialized into one system message and then dropped
when the run ended. `promoteMemory` is called once, at settle, with it.

A callback rather than a store the runtime writes into: what is worth
remembering is a policy question the host owns, and a runtime that
decided it would write a row for every run whether or not anything
happened.

- Called for a **failed** run too. A run that fell over still discovered
  things, and the approach that failed is exactly what a later run should
  not pay for twice.
- **Awaited**, not fire-and-forget: a one-shot process exits as soon as
  the run returns, so the write would be lost precisely on the shortest
  runs.
- A **throw is swallowed** and logged. A memory that failed to form must
  not retract an answer that was already produced. A host that needs the
  write to be part of the run's success should do it in its own code,
  where it can fail loudly.
- Requires an extractor. With no `compactionConfig` there is no working
  state, and inventing an empty candidate would ask a host to store a
  record of nothing.

## 7. Extended Thinking and Effort

```ts
query({
  // …
  runConfig: {
    // …
    thinking: { type: 'adaptive' },
    effort: 'high',
  },
})
```

`thinking` says whether the model reasons before answering; `effort` says
how much work it spends on the call. They are **siblings** on `AgentRunConfig`
rather than one nested in the other, because on some models they are
independent controls that apply together — see
[Run Configuration](./configuration.md) for the mode-by-mode breakdown of which
of the two sets depth.

**They are not exclusive to `query()`.** Both are declared on `BaseAgentConfig`,
so `runAgent`, `ReactiveAgent`, `SupervisorAgent` and the agent manager's
bare-config branch all forward them. That is worth stating because it was not
true until recently: every one of those entry points assembles its run config by
hand-listing fields, so `thinking` was settable on an agent config and dropped
in silence by all four — no cast to blame, no error to see, and a perfectly
ordinary answer at the other end. If you set either field anywhere other than
`query()` and are on an older kernel, check that it reaches the wire before
trusting it.

**A driver that cannot honour either one refuses the run rather than dropping
it.** Effort is the reason this rule matters most: a dropped `thinking` at least
leaves an empty reasoning list, while a dropped `effort` leaves an answer
indistinguishable from one the model produced at its default — including in what
it cost.

Reasoning blocks are stored on the assistant message and replayed
**verbatim**, signature intact — the assistant turn preceding a `tool_result`
has to be echoed back unchanged, and a rebuilt turn triggers ordering and
signature errors.

The lifecycle surfaces as `reasoning_started` / `reasoning_delta` /
`reasoning_completed`, so a streaming UI can show that the model is
working instead of a silent multi-second gap. The delta is ephemeral: the
completed block carries the full text, and the transcript records that.

Some wires reject `temperature`, `top_p` and `top_k` while thinking is
enabled. A driver on such a wire omits them rather than sending a request it
knows will fail — which sampling parameters and which effort levels a given
model accepts is the driver's to resolve, not the kernel's. See
[Anthropic Provider](../../providers/anthropic.md) for one worked example.

## 8. Guardrails

The three gates on tool calls — probe veto, `VerificationGate`, HITL review
— all point the same way: they protect the world from the agent. Guardrails
are the other direction.

```ts
import { secretRedactionGuardrail } from '@namzu/sdk'

query({
  inputGuardrails: [({ messages }) => /* … */ ({ action: 'pass' })],
  outputGuardrails: [secretRedactionGuardrail()],
})
```

- **Input** guardrails run before the first model call, so a refusal costs
  nothing. A block settles the run as `input_guardrail`.
- **Output** guardrails run against the final result. A block settles as
  `output_guardrail`; a `rewrite` replaces the text, so a redaction policy
  can clean an answer rather than discard it. Rewrites compose.
- A guardrail that **throws fails closed**, deliberately the opposite of
  `stopWhen`: a broken halt predicate should not kill a healthy run, but a
  broken safety check must not wave content through.

Both stages emit `guardrail_triggered` (wire: `guardrail.triggered`).

> **Output guardrails gate the result, not the stream.** `text_delta`
> events have already reached the host by the time one runs, so a rewrite
> arrives as a *correction* alongside the event. Gating the stream itself
> would mean buffering every token — trading the streaming UX for the
> guarantee — which is a host decision, not the SDK's.

Presets: `secretRedactionGuardrail(options)` (prefix-anchored credential
patterns; redacts by default, `onMatch: 'block'` to refuse) and
`promptInjectionGuardrail()` (partial by design — it raises the cost of the
lazy attack, it is not a boundary).

## 9. Repairing a Bad Tool Call

A malformed call otherwise costs a full round trip: the error goes back as
a `tool_result`, the model re-reads the entire context, and issues a second
inference to add a missing brace.

```ts
query({
  repairToolCall: async ({ toolCall, reason, jsonSchema, availableTools }) => {
    if (reason !== 'invalid_json') return null
    return { arguments: await fixJson(toolCall.function.arguments, jsonSchema) }
  },
})
```

The hook sees the reason (`invalid_json`, `schema_validation`,
`unknown_tool`), the tool's JSON Schema and every registered tool name, and
may rewrite the **arguments** and the **tool name** — nothing else. It
cannot invent a call the model never made, nor suppress one.

It is tried exactly once (a repairer that produces a still-broken call will
not do better on a second look, and an unbounded loop is a hang). A throw
is caught. Declining with `null` is normal: the original error proceeds to
the model as before.

### Per-tool retry budget

```ts
const tool: ToolDefinition = {
  name: 'fetch_page',
  maxRetries: 2,
  execute: async () => ({ success: false, output: '', error: 'ECONNRESET', retryable: true }),
  // …
}
```

`maxRetries` **defaults to 0, and that default is load-bearing.** Retrying
is only safe if the tool is idempotent and the SDK cannot know that:
silently re-running a write, a `git push` or a payment is worse than never
retrying. Even opted in, only failures the tool marked `retryable` are
retried — a missing file will not appear on the second attempt.

A `post_tool_use` plugin hook returning `{ action: 'retry' }` also re-runs
the tool, bounded by the same budget.

## 10. Typed Failures

```ts
import { toPlatformError } from '@namzu/sdk'

try {
  await drainQuery(params)
} catch (err) {
  const { code, message, retryable, details } = toPlatformError(err)
}
```

`toPlatformError` normalizes **anything** thrown into one shape — a
`NamzuError`, a `ProviderError`, a plain `Error` from a dependency, or a
thrown string — so "handle errors from the SDK" is one handler rather than
an `instanceof` ladder per call site. A `ProviderError` keeps its own
classification: its code lands in `details.providerCode` and its
`retryable` verdict is preserved, not recomputed.

`NamzuErrorCode` is deliberately small — each member exists because a
caller does something different about it: `invalid_config`,
`provider_error`, `tool_error`, `not_found`, `plugin_error`,
`capability_unavailable`, `storage_error`, `unknown`.

## 11. Crash Save

```ts
query({ emergencySave: true })
```

Installs SIGINT / SIGTERM / `uncaughtException` handlers that dump run
state to `<runDir>/../emergency/<runId>.json`, readable by
`replay({ fromCheckpoint: 'emergency' })`. Handlers are removed when the
run settles.

**Off by default, deliberately.** Attaching means calling `process.on(...)`
with handlers that `process.exit()`; a library must not seize its host's
termination path, and an API server has its own drain sequence. The
manager is also a singleton, so under concurrent runs an automatic attach
would make the last-started run the only one ever saved. Turn it on for a
process that owns its run end to end — a CLI, a single-run worker.

## Related

- [SDK Runtime](./README.md)
- [Runtime Configuration](./configuration.md)
- [Replay and Checkpoints](./replay.md)
- [SDK Tools](../tools/README.md)
- [Telemetry](../observability/README.md)
