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
output-tool call is reviewed for settlement; a candidate alongside other calls
is relayed until the model has observed their results.

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
host hook errors or modifications, and damaged retained output receipts are
not model schema corrections. A damaged receipt remains an integrity error.
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

In tool mode, settlement reads the retained tool-result JSON, not a separate
result artifact. The default tool-output budget is 40,000 characters. A
truncated or transformed receipt that is no longer JSON fails the turn before
review, including when no reviewer is configured. No raw-text fallback is
published in `Turn.structuredOutput`; the runtime does not recover raw tool
input or data that would bypass result screening or hooks. Hosts expecting
larger results must raise `maxToolOutputChars` (or explicitly set zero to
disable that cap) and budget model context accordingly. Alternatively, select
[native mode](native-structured-output.md) with a capable provider; native
results do not pass through the tool-output preview cap. A separate durable
structured-result channel remains future work.

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
