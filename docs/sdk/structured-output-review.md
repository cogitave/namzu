---
type: Reference
title: Structured output review
description: Host validation of parsed structured results, bounded corrections and checkpoint recovery.
resource: packages/sdk/src/types/structured-output/index.ts
tags: [sdk, harness, verification]
---

# Structured output review

`QueryParams.structuredOutput.review` checks the parsed result after the output
tool has validated its schema and before `Turn.structuredOutput` is published.
The callback receives a cloned JSON-decoded value (`unknown`) and an `AnswerReviewContext` containing
turn identity, iteration, messages and the turn's cancellation signal. Its optional
`generateText` capability provides [one metered, bounded review inference](verification.md#turn-owned-review-inference)
per callback; the parsed candidate and response schema are not implicitly sent
to that auxiliary request. Its optional
[`requestMessages`](verification.md) is the isolated SDK request snapshot which
produced this candidate, including ephemeral evidence and image-recovery edits.
It excludes the candidate and any results produced after that dispatch. Mutating
that clone does not change the published result. Narrow or validate the value
before use: tool-result processing and JSON serialization do not preserve every
possible Zod output type. Native mode rejects transformations that produce
non-JSON data. The kernel does not rerun schema transforms during review.

`latestUserMessage` supplies the latest accepted operator/goal/steering input at
candidate dispatch, retained across compaction. It is an isolated copy and does
not include later arrivals. It is one input, not the full task specification.

```ts
import type { StructuredOutputConfig } from '@namzu/sdk'
import { z } from 'zod'

const schema = z.object({ score: z.number() })
const structuredOutput: StructuredOutputConfig<typeof schema> = {
  schema,
  maxReviews: 2,
  review: (output) => schema.parse(output).score < 10
    ? { accept: true }
    : { accept: false, feedback: 'Return a score below ten.' },
}
```

A rejection must supply nonempty feedback. It becomes runtime context for the
next model request, preserving the current conversation. `maxReviews` is a
nonnegative safe integer: the default is three correction opportunities; zero
stops after the first rejected candidate. Exhaustion stops with `answer_rejected`
and no accepted structured result. Schema retry limits remain separate.

Thrown errors and malformed verdicts fail the turn. Cancellation stops waiting
for the reviewer, even if its promise does not settle; external work started by
the callback must still honor the supplied signal. Only a solitary successful
output-tool call that was not skipped is reviewed for settlement; a candidate
alongside other calls is relayed until the model has observed their results.

A pre-tool hook skip carries executor-owned `skipped: true` completion
metadata. Its non-error explanation is not a structured candidate, even when
the output tool was the only requested call. It returns to the model without
JSON candidate parsing, host review or publication of `Turn.structuredOutput`.
This also keeps a skipped `terminal: true` tool from ending the turn with its
explanation. The marker survives the event, persisted completion, recovery and
`StepToolResult` paths. Strict admission requires `isError: false` and no
`inputFailure`; neither skip-looking text nor raw tool-result/provider
properties supply the marker. Legacy completions without it are not
reclassified from their text.

Before publishing an accepted tool-mode candidate, the loop checks for inbound
messages and steering, including steering already attached to that tool's
result. A new input gets another model turn with a fresh candidate and review.
The old candidate's review remains bound to its dispatch input. This also works
without a host reviewer. Forced finalization and existing turn limits still apply;
an interrupted turn does not publish a pending candidate as completed output.

A rejection saves feedback and `Checkpoint.review.structuredAttempts`
before the next model request. Resume restores that counter independently of
message compaction. Supply the same review configuration when resuming. This is
checkpoint state, not a tamper-proof lifetime quota: selecting an older checkpoint
restores its older counter, and changing the host policy changes the allowance.
The callback itself is host code and is not serialized.

Tool mode remains the default. [Native mode](native-structured-output.md) uses
provider response schemas with local validation and the same host reviewer.
Existing prose `reviewAnswer` behavior is unchanged.

Tool mode accepts asynchronous Zod refinements and JSON-safe transforms through
[async input preparation](tool-execution.md#preparing-asynchronous-input), as
native mode does. The schema runs once per candidate before its normalized
value is reviewed and executed; settlement and host review do not rerun it.
Schema mismatches use the correction allowance below. A thrown validator error
or cancellation is not a trusted mismatch and cannot spend that allowance as
though it were one. Cancellation while awaiting validation publishes no candidate.

## Tool-mode schema corrections

`maxRetries` allows two corrections by default: an initial response and up to
two further responses. Zero stops on the first missing or invalid output with
`structured_output_failed` and no accepted `structuredOutput`. Tool-free prose,
empty responses, truncated prose and unrepaired invalid JSON, truncated arguments
or schema mismatches from `structured_output` share this allowance. A response
with several invalid output calls consumes one correction after every sibling
tool result has been recorded. Ordinary tool work and valid output candidates
paired with other tools consume no schema correction.

Argument repair that produces a valid call, permission refusals, cancellation,
host hook skips, errors or modifications, and damaged retained output receipts
are not model schema corrections. A skipped output has no candidate and consumes
no `maxRetries` correction; repeated skips remain bounded by the existing turn
limits, including `maxIterations`. A damaged receipt remains an integrity error.
Host reviewer rejections use the separate `maxReviews` allowance. Admission
classifies failures once; accounting does not rerun schema transformations or
infer a failure category from error text.

`Checkpoint.review.toolStructuredAttempts` records the consumed corrections,
independently of native validation and host review. The answered batch, correction
feedback and count are committed before another request, including exhaustion.
A checkpoint-write failure prevents another request. Compaction preserves the
counter; resume of an exhausted checkpoint makes no new model request. A resumed
pending batch first answers all its owned calls and then accounts its verified
argument failures once. Legacy checkpoints lacking this optional field restore
zero without rewriting their original bytes or hashes. Supply the output
configuration again on resume; selecting an older checkpoint restores that
checkpoint's count.

By default, tool-mode settlement reads the retained tool-result JSON. The
default tool-output budget is 40,000 characters. A
truncated or transformed candidate receipt that is no longer JSON fails the turn
before review, including when no reviewer is configured. Legacy synthetic
receipts without a trusted skip marker retain this integrity check; the runtime
does not infer a skip from their wording. No raw-text fallback is
published in `Turn.structuredOutput`; the runtime does not recover raw tool
input or data that would bypass result screening or hooks. Hosts expecting
larger results must raise `maxToolOutputChars` (or explicitly set zero to
disable that cap) and budget model context accordingly. Alternatively, select
[native mode](native-structured-output.md) with a capable provider; native
results do not pass through the tool-output preview cap. The opt-in retention
below separates a tool-mode candidate from that preview.

## Retaining structured tool results

Set `toolResultRetention: 'durable'` in tool mode to retain the final selected
JSON text before the tool-output preview budget applies. The default and explicit
`'receipt'` keep the behavior above. Native mode rejects `'durable'`, since it
does not use tool receipts; unknown retention values are rejected before inference.

```ts
import type { StructuredOutputConfig } from '@namzu/sdk'
import { z } from 'zod'

export const output: StructuredOutputConfig = {
  schema: z.object({ report: z.string() }),
  toolResultRetention: 'durable',
  review: (candidate) => candidate === null
    ? { accept: false, feedback: 'Return a report object.' }
    : { accept: true },
}
```

Retention occurs after tool-result guardrails and `post_tool_use` hooks, using
their selected `output` text. A JSON redaction or replacement becomes the
candidate; the original `ToolResult.data` and tool arguments are never recovered
as an alternative. This follows the same text channel as receipt settlement.
Rich provider `content` remains a separate model channel. The schema is not rerun
while retaining, decoding or reviewing the result; host replacements remain
host decisions, and review can enforce an additional result policy.

Only the exact runtime output-tool definition on a successful, prepared direct
`structured_output` call can mint `structuredResultJson`. A failed, denied,
skipped or nested call, or cancellation observed before completion recording,
cannot mint it; a different definition or a
different original tool name routed to that tool cannot inherit retention.
Malformed selected JSON retains the ordinary completion receipt and fails the
candidate-integrity check without charging a schema correction. Retained JSON
must decode to JSON-safe values, including finite numbers; unsafe transformed
host values are not an alternate result channel.

`tool_completed.structuredResultJson` contains the full JSON string in the live
host event and persisted completion. This is an explicit additional host-visible
payload: `maxToolOutputChars` still bounds `result` and model-visible tool messages,
not this field. It is absent from provider messages and `StepToolResult`. The
host reviewer receives an isolated full decoded value; `Turn.structuredOutput`
and `Turn.result` publish it only after the existing review, inbound-message,
cancellation and final output-guardrail checks. A recorded candidate is execution
evidence, not proof that it was accepted.

Cancellation during an asynchronous completion append may leave evidence of
the already executed call in the log. The later cancellation checks still
prevent that candidate from being accepted in the cancelled turn.

The verified recovery scan carries this optional field into `CompletedToolRecord`
and recovered batch outcomes without reexecuting the tool or its schema. An
absent field uses the existing receipt path; only an intact JSON receipt can then
supply a candidate. This includes legacy records and host-provided output tools
when the runtime output tool was disabled: the exact-definition binding applies
to minting retained evidence, not to replacing existing receipt settlement.
A present malformed or contradictory field is refused, never silently
downgraded to a preview or raw input. Existing resume policy remains unchanged:
after answering a restored pending batch, the loop requests fresh inference;
it does not automatically review or publish a pre-crash candidate, since the
original review dispatch snapshot is not restored by this option.

Without structured-result spilling, retention remains bounded by the
[session log](session-log.md) record ceiling of 4 MiB, including JSON escaping
and metadata. This is not a promised maximum candidate size. The completion and
final settlement must fit; a write failure can reject the query without a
durable terminal record or returned `Turn`, and does not make an oversized
result accepted.

### Spilling large structured results

Built-in session logs accept `structuredResultSpilling: true`. The default is
`false`, preserving inline records. This is a storage option, separate from
`toolResultRetention`: tool mode needs durable retention to retain a full
candidate independently of its preview. Native mode can use the same log option
for its accepted final JSON without enabling tool retention.

When the serialized record exceeds `spillAboveBytes` (default 4 MiB), the log
writes the full JSON to its checked spill store before appending the record:

| Recorded value | Persisted representation |
| --- | --- |
| Screened, post-hook tool candidate | `tool_completed.structuredResultSpill`, without `structuredResultJson` |
| Accepted final value | `turn_completed.structuredOutputSpill`, without `settlement.structuredOutput` |

Each structured JSON body is limited to `STRUCTURED_RESULT_MAX_BYTES`, **16 MiB
of UTF-8 text**, independently of JSON escaping in the record. The two bodies
use separate record-scoped keys; model-preview files cannot supply either one.
Other fields, including the ordinary tool receipt, still have to fit inside the
4 MiB record. Small results stay inline, and the live event, reviewer and returned
`Turn` keep their full value. A recorded candidate still does not prove acceptance.

```ts
import { DiskSessionLog, readStructuredOutput } from '@namzu/sdk'
import type { SessionPaths, SessionLocator } from '@namzu/sdk'

export async function lastStructuredOutput(
  paths: SessionPaths,
  locator: SessionLocator,
) {
  const log = DiskSessionLog.at(paths, locator, { structuredResultSpilling: true })
  const verified = await log.readAll({ mode: 'strict' })
  const completed = verified.entries
    .map((entry) => entry.record)
    .reverse()
    .find((record) => record.type === 'turn_completed')
  if (!completed || completed.type !== 'turn_completed') return undefined
  return readStructuredOutput(log, completed)
}
```

Raw log reads preserve references; callers supply a record from a verified log
read to `readStructuredOutput`. The helper checks session identity, record
classification, byte length, SHA-256 and JSON safety, without rerunning a tool,
schema or reviewer. Its optional `{ signal }` cancels the read. A missing or
corrupt body is an error, never an inline-preview fallback. Built-in bounded
disk reads refuse symlinks, nonregular files, oversized actual bodies and invalid
UTF-8 before publication. Custom readers receive the byte limit and signal;
the helper also verifies their returned bytes, but cannot constrain an
uncooperative backend's internal allocation or execution.

Completed-call recovery hydrates only the latest selected completion after the
whole log verifies. Superseded retries do not read obsolete bodies. An unreadable
current body leaves the outcome unknown and cannot authorize automatic replay.
The recovery snapshot has a 64 MiB aggregate structured-body budget, checked
before any spill read; exceeding it also leaves outcomes unknown.
Resume still requests fresh inference; original review-dispatch recovery and a
general typed `ToolResult.data` artifact channel remain separate work. Storage
failure and cancellation can retain already written evidence without publishing
an accepted result. Spills have no automatic garbage collection in this option.

## Anthropic provider-level native JSON format

Direct `AnthropicProvider.chatStream` calls now forward
`ChatCompletionParams.responseFormat` with `type: 'json_schema'` to
`output_config.format`, preserving any sibling reasoning `effort`. The mapping
follows the [Anthropic structured-output API](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).
The shared schema `name` is not an Anthropic format field and is not sent.

```ts
import { AnthropicProvider } from '@namzu/anthropic'
import type { ChatCompletionParams } from '@namzu/sdk'

export function streamNativeJSON(provider: AnthropicProvider, request: ChatCompletionParams) {
  return provider.chatStream({
    ...request,
    responseFormat: {
      type: 'json_schema',
      json_schema: {
        name: 'score',
        strict: true,
        schema: {
          type: 'object',
          properties: { score: { type: 'number' } },
          required: ['score'],
          additionalProperties: false,
        },
      },
    },
  })
}
```

Native Anthropic output always constrains the schema. `strict: false` and
schema-free `json_object` are rejected locally as `ProviderRequestError` with
`kind: 'bad_request'`. Omitting `strict` uses native schema enforcement. The
driver forwards the schema without weakening unsupported constraints; the
vendor still decides model and schema compatibility. Callers must inspect the
finish reason and validate the returned text before consuming it.

Loopback HTTP tests exercise the real vendor SDK request encoding and streamed
response, including effort coexistence and refusal before network dispatch.
They do not establish live model or subscription eligibility. This fixes the
driver transport seam; `QueryParams.structuredOutput.mode: 'native'` now connects
it to local validation and review. Tool mode remains the default.
