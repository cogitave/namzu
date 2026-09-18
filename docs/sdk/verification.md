---
type: Reference
title: Answer verification
description: Command-backed answer review, interrupted checks, cancellation and the distinction between settled and verified work.
resource: packages/sdk/src/run/command-gate.ts
tags: [sdk, harness, verification]
status: stable
---

# Answer verification

A settled run and a verified objective are different facts. `Run.status` describes
execution; `stopReason` records why it stopped. A model's closing answer is a claim,
and passing tests establish only the behavior those tests cover. Acceptance checks
should be independently derived from the task's requirements and current state.

`reviewAnswer` examines a model's proposed prose answer and can return
`{ accept: false, feedback }` to request another iteration. The feedback is runtime
context, not a new operator instruction. `maxAnswerReviews` bounds the permitted
rejections; exhaustion stops with `answer_rejected`. `AnswerReviewContext.signal`
carries run cancellation and should be forwarded to verification operations.

`AnswerReviewContext.requestMessages` optionally supplies an isolated copy of the
SDK messages dispatched for the candidate being reviewed. The built-in loop
supplies it to prose, tool-output and native structured-output reviewers. This
includes request-only step context, such as automatically recalled passages,
which is absent from durable `messages`. The candidate answer and later tool
results or arriving messages are not appended to this snapshot. Earlier answers
already in the dispatched history remain present.

Capture happens after request projection and follows the last dispatch when an
image-recovery retry changes the request. It describes the SDK provider-chain
input, not the vendor wire: provider/fallback transformations, native tools and
private reasoning replay can still change what the remote model receives. The
snapshot does not authenticate its contents, authorize archive access, or prove
file freshness. A verifier of retained evidence must revalidate the quoted
source's scope, address and bytes before accepting its own task-specific claim.

Runs with a prose/structured reviewer or configured
[advisory context](advisory-context.md) capture this request; it adds no model
call or archive read by itself. Its memory cost is another copy of that projected
request, including its rich content. A reviewer may retain its received copy,
but the kernel keeps no cross-turn archive of these snapshots. Mutating nested
objects in the copy cannot edit the dispatched request or canonical history.
It is not checkpointed or restored; resumed model turns capture a fresh request.
Existing `messages` keeps its canonical-history meaning. A custom host omitting
`requestMessages` must not be assumed to have supplied the transient evidence.

`AnswerReviewContext.latestUserMessage` optionally supplies a separate, isolated
copy of the latest accepted operator, goal-round or steering input at candidate
dispatch. The built-in loop shares preparation's retained input tracking, so
compaction can remove the original from history without replacing it with an
older retained request, project instructions or a worker report. Checkpoint
resume restores that tracking; a known later input supersedes it. Input delivered
after candidate dispatch belongs to a later decision, not this review.

This field contains one input, not a complete task specification. A follow-up
may depend on earlier constraints. It also does not assert that the original
message reached the provider verbatim: compaction may have represented it in
working state. The isolated copy includes rich message content and costs that
additional memory only when a reviewer is configured. Editing it cannot change
canonical history, retained input tracking or a later review. Custom hosts may
omit it. It is not automatically sent to `generateText`.

The [recorded CLI Session probe](../../research/conversation-evidence/review-request-results.md)
checks a corrupted receipt against request-only evidence, revalidates the
archive, and requests a bounded correction. This is a task-specific policy,
not a default CLI factual judge or an automatic identifier normalization rule.

## Explicit JSON claims

`createJsonClaimVerifier` supplies a provider-independent check for host-defined
fields. It accepts 1–32 `JsonClaimRequirement` entries: a unique `id`, a host-owned
`source` identifier and an RFC 6901 `pointer`. An optional `expected` value adds
a postcondition. Candidate/source equality alone does not prove the requested
change occurred. Values are strings (up to 2,000 characters), booleans, null or
safe integers; use strings for decimals or larger exact numbers. Pointers select
own JSON properties and canonical array indices. JSON uses JavaScript's parse
semantics, including numeric rounding and last-key-wins for duplicate object keys.
Numeric checks apply to parsed values, not the number's original spelling; use
string-valued quantities when lexical decimal precision matters.

The host creates one verifier for a specific authorization `scope` and `runId`,
then calls `verify(claims, reviewContext)` from its existing answer or structured
reviewer. Claims must contain exactly the configured IDs. The host still owns
answer parsing and decides which dispositions require these checks. Reuse the
runtime's review budget; the helper does not start a model or manage retries.

Each verification calls the trusted `observe(source, request)` adapter once per
distinct source. The request carries the bound scope/run, review iteration, fresh
request ID, start time, remaining byte allowance and an abort signal. The adapter
must perform an authorized **read**, bound capture, honor cancellation, and return
complete bytes observed during that request. A receipt marked historical,
incomplete, from another request/scope/source, or outside the observation interval
is rejected. Envelopes guard accidental reuse; they cannot authenticate a dishonest
host adapter. An assistant claim, successful action receipt, hash supplied by a
model, or archive relabelled as current is not a replacement for that observation.

The verifier parses complete, valid UTF-8 JSON itself, selects fields and compares
values. There is no success cache. It returns `{ accept: true, receipt }` only after
all checks pass. Receipts bind checked claim values to source names, request IDs,
observation times, byte counts and full SHA-256 hashes of the inspected bytes.
Failure returns bounded feedback without source values. The default total source
allowance is 1 MiB per review (maximum 8 MiB); the whole review defaults to two
seconds (maximum 30 seconds). These limits do not bound a misbehaving adapter's
capture or allocations; the host must enforce its side of the contract.

Timeout revokes the observation and rejects. Caller cancellation propagates its
reason. Further verification is refused while an earlier observer remains pending;
`isDrained()` exposes this condition so a host can retain execution ownership.
Successes and callbacks are not checkpointed. A resumed host must reconstruct its
policy and make fresh observations. Never replay an action to recover evidence.

These are observation-time receipts, not atomic multi-source snapshots, durable
truth guarantees, or verification of arbitrary summary prose. Sources may change
after a read. If an operation needs atomic check-and-use, implement that transaction
in its authoritative host. Streamed candidate text is not undone by later rejection.
See [resident CLI verification](../cli/resident-work.md#configured-claim-verification)
for a concrete adapter and command.

## Run-owned review inference

The built-in loop also supplies optional `AnswerReviewContext.generateText` to
prose and structured reviewers. It shares `PreparationTextRequest` and
`PreparationTextResult` with [bounded preparation inference](step-context.md#bounded-preparation-inference).
It permits one tool-free call per review callback, on the run's metered
provider/retry/fallback chain, using the selected step model and run effort.
Supplying a reviewer alone makes no auxiliary request; the callback must call
and await the capability. A later correction receives a fresh capability.

Only the callback's explicit `system` and `prompt` strings are sent. Candidate,
request snapshot, conversation, tools, native output schema and private reasoning
are not attached automatically. Together the strings are limited to 12,000
UTF-16 units. `maxTokens` defaults to 256 and is capped at 1,024. Returned visible
text is limited to 8,192 units. A local signal may shorten the run/callback
lifetime. These are input, output and admission bounds, not a guaranteed provider
billing ceiling.

`timeoutMs` is accepted and validated and no longer bounds the request, for the
reason [bounded preparation inference](step-context.md#bounded-preparation-inference)
states: an auxiliary request that ends without its usage receipt leaves the shared
ledger unresolved, and an unresolved request admits nothing further, so a deadline
that fired in normal use ended the run instead of the call. The call is bounded by
the provider's request timeout and by the run's cancellation.

The callback's completion, error or cancellation revokes the capability.
Await every admitted call before returning a verdict. Invalid tool-bearing or
oversized output is drained for usage without executing tools; missing usage or
cancellation can leave an unresolved receipt, which remains in the shared budget.
Auxiliary usage and cost belong to the run, but do not alter the candidate's
main-step usage or provenance. A review fallback may serve later requests; it
does not relabel the candidate that was already produced. No auxiliary messages
or invocation capability are saved as conversation history or checkpoint state.

A returned model judgment is fallible and must be parsed and checked by the
host. A reviewer exception still fails settlement; only an explicit, valid
rejection asks for a correction. Hosts constructing review contexts themselves
may omit this capability. This is not an automatic CLI judge, an inferred
acceptance specification, or an expansion of which settlement paths invoke review.

The [CLI Session experiment](../../research/conversation-evidence/review-inference-results.md)
separates authenticated archive access, a bounded model judgment, the correction
request and the run's combined budget receipt.

## Verdicts and correction

Verdicts must explicitly return a boolean `accept`. Rejections require nonempty
string feedback. A thrown error or malformed verdict fails the run; it neither
accepts an unverified answer nor consumes model calls by repeatedly retrying a
broken verifier. This changes the former exception-as-acceptance behavior.
Hosts deliberately choosing that behavior must catch errors in their callback
and return `{ accept: true }` themselves. Cancellation stops waiting for an
unsettled reviewer, including one that ignores the signal; work started by the
callback remains the host's responsibility to cancel.

`maxAnswerReviews` is a nonnegative safe integer, default three correction
opportunities. Zero stops on the first valid rejection. Each rejection commits
its feedback and `IterationCheckpoint.answerReviewAttempts` before another
request, including the rejection that exhausts the allowance. Resume restores
this count independently of compacted messages. Supply the same review policy
when resuming; restoring an older checkpoint or changing host policy changes
the allowance. Checkpoints without a recorded counter start at zero, and invalid
stored counters are refused before model work. This is checkpoint state, not a
tamper-proof lifetime quota.

```ts
import { createCommandGate } from '@namzu/sdk'

const reviewAnswer = createCommandGate({
  commands: ['pnpm typecheck', 'pnpm test'],
  cwd: process.cwd(),
  maxRetries: 3,
  timeoutMs: 60_000,
  maxOutputChars: 4_000,
})

// Supply reviewAnswer and maxAnswerReviews: 3 to query() or drainQuery().
```

The command gate runs operator-supplied shell commands in order and stops at the
first failure. Default command timeout is ten minutes; default execution attempts
are three. The model does not supply these commands. Custom executors own their
containment and must honor the timeout and cancellation options they accept.
The default executor owns its local process group and receives run cancellation.

Every command must finish with exit zero and no termination receipt. A process
that handles a timeout or cancellation by exiting zero has not completed the
verification. Executor exceptions become rejection feedback, so an unavailable
verifier cannot become an accepted answer through the generic hook's exception
path. If cancellation arrives during review, the run remains cancelled.

After a normal failed check, a workspace fingerprint can avoid an identical retry.
An unavailable or throwing fingerprint means the command may run again; it never
means success. Interrupted checks and executor failures are not cached as stable
source failures. The detector includes the Git commit and Git-visible uncommitted
state, so committing a fix cannot look like the previous clean commit. Interrupted
Git commands cannot establish a fingerprint even when they exit zero. It excludes external
services, ignored artifacts or every possible input to a command. It is an
optimization, not proof that two verifications must have identical outcomes.
Use a custom `fingerprint` that includes the command's relevant inputs, or returns
`null` to always run checks, when verification depends on state outside Git.

`maxOutputChars` is a nonnegative safe integer. The clipped diagnostic, including
its omission marker, stays within that allowance. Zero suppresses the diagnostic
body; short positive allowances may contain only an ellipsis. The surrounding
feedback also names the command and failure, so this option is not a cap on the
entire review message. Custom executors must separately bound captured output.

## Scope and limits

Review is called on ordinary prose completion. Forced finalization, terminal tools
and structured-output settlement have separate paths; `reviewAnswer` is not an
unbypassable objective-verification boundary. The built-in command reviewer
contains command/fingerprint errors and forwards cancellation. Custom prose and
structured reviewers both distinguish valid rejections from verification failures,
but cannot stop external work whose implementation ignores cancellation.

A limit-triggered closing prose response preserves the guard's `token_budget`,
`cost_limit` or `timeout` stop reason. It is retained as partial work even when
the provider reports a normal text completion. This can happen at the warning
threshold while allowance remains; it does not imply the hard ceiling was
exhausted. A previously rejected candidate does not become accepted because the
next response bypassed review. Cancellation still takes precedence. Validated
native structured output retains its separate schema/review settlement path.

The CLI's headless `run` and `run-stream` commands accept repeatable `--gate`
commands and `--gate-retries`; the TUI does not automatically install this gate.
Output guardrails can judge the final result across more settlement paths, but
streamed text may already have reached the host. Neither mechanism infers a
complete acceptance specification from arbitrary natural language.

The [cognitive architecture research](cognitive-architecture.md) separates model
assertions, independent behavior checks and proposed executive control. A hidden
test suite that rejects a completion is evidence of a missing behavior, not proof
that memory loss caused it.

The separation of corrective feedback from a failing validator follows
[output validation](https://pydantic.dev/docs/ai/core-concepts/output/)
and its distinction between `ModelRetry` and ordinary output-validator
exceptions in [advanced tool behavior](https://pydantic.dev/docs/ai/tools-toolsets/tools-advanced/).
This does not supply an automatic factual judge. Quote containment, correct
source selection, semantic support and complete answers are separate checks;
the host must define which claims its verifier can establish.

The [CLI copy/transform controls](../../research/conversation-evidence/copy-intent-results.md)
also distinguish source identity from the requested result. Requiring every
answer to equal a recalled identifier rejects legitimate lowercase, prefix and
example-generation requests. Normalizing a value before comparison can instead
hide a spelling error. A verifier needs the task's claim or transformation
contract; source visibility by itself supplies neither.

The [task-conditioned review experiment](../../research/conversation-evidence/task-review-results.md)
tests correct and incorrect candidates for quoting, explicit transformations,
new examples and current-state questions. Its model verdict is separate from
source authentication and from the test oracle; it does not install a default
CLI judge or infer a complete acceptance specification for arbitrary tasks.
