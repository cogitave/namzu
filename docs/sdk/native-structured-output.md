---
type: Guide
title: Native structured output
description: Query-level JSON Schema response constraints, local validation, host review, cancellation and recovery.
resource: packages/sdk/src/runtime/query/iteration/native-output.ts
tags: [sdk, providers, harness, structured-output]
---

# Native structured output

Set `structuredOutput.mode: 'native'` to send a JSON Schema response format
instead of registering the synthetic `structured_output` tool. The default
remains `'tool'`. Normal tools can still run; an answer accompanying tool calls
is not accepted until a subsequent tool-free response arrives.

```ts
import { drainQuery, type QueryParams } from '@namzu/sdk'
import { z } from 'zod'

const schema = z.object({ score: z.number() })
export function extractScore(params: QueryParams) {
  return drainQuery({
    ...params,
    structuredOutput: {
      mode: 'native',
      schema,
      maxRetries: 2,
      maxReviews: 1,
      review: (value) => schema.parse(value).score < 10
        ? { accept: true }
        : { accept: false, feedback: 'Score must be below ten.' },
    },
  })
}
```

The selected driver must explicitly declare
[support for native structured output](native-provider-capabilities.md).
OpenAI API, Codex, Anthropic, OpenRouter, DeepSeek, HTTP and Zen declare their wire mappings.
Each actual fallback member is checked before dispatch; unsupported routes fail
rather than ignoring the schema. This is a driver contract, not a claim that
every model accepts every schema. Vendor compatibility errors remain errors.

The query sends the rendered schema with name `structured_output` and
`strict: true`. It does not silently remove constraints the vendor cannot
express. Local Zod validation remains necessary for refinements and application
requirements not represented in JSON Schema.

## Acceptance and correction

Only a tool-free response with finish reason `stop` can become a candidate.
Malformed JSON, schema mismatches, truncated responses and content-filtered
responses are refused. A correction asks for a complete JSON value, never a
continuation fragment. `maxRetries` bounds these correction opportunities
(default three); zero stops after the first invalid candidate with
`structured_output_failed`. The general iteration, token and time budgets
still apply. Forced finalization cannot bypass validation or request an
unvalidated prose summary.

Async Zod validation and transformations run once per candidate. A transformed
result must still be losslessly representable as plain JSON: functions, Date
instances, undefined values, nonfinite numbers, accessors and cycles fail the
run. Validation exceptions fail the run; cancellation stops waiting even for
an uncooperative async validator. Host callbacks must still cancel their own
external work.

Valid candidates go through the same [host review](structured-output-review.md)
as tool-mode results. Host rejection allowance is separate from schema
corrections. Pending operator corrections and delegated work are considered
before native acceptance, within the run's existing finalization limits.
Cancellation before settlement does not publish the candidate. The accepted
value lands in `Run.structuredOutput`; native output does not traverse the tool
preview cap, so a large JSON response is not truncated by `maxToolOutputChars`.
Provider output and context limits still apply.

An output guardrail can still invalidate the result after review. Blocking or
rewriting clears `structuredOutput`; a rewrite of a configured structured run
stops with `output_guardrail`, preserving the host's replacement text without
presenting it as schema-validated success. Use structured review to request a
new valid candidate. `RunManager.clearStructuredOutput()` clears the structured
field without replacing text. Failed and cancelled runs also clear that field.

## Checkpoints

`IterationCheckpoint.nativeStructuredAttempts` records consumed native
correction opportunities. Rejection feedback and the updated count are saved
before the next model request, separately from the host-review count. Message
compaction cannot reset either counter. Resume requires the host to supply its
schema, mode and review configuration again. Restoring an older checkpoint
restores its older counters; this is checkpoint state, not an immutable quota.

Deterministic tests exercise the real query loop, tool interleaving, async
validation, rejection, cancellation, steering, guardrails, large output and
checkpoint restoration. Driver tests inspect actual request bodies, including
Anthropic through its SDK against a loopback HTTP server. No paid inference or
live model eligibility is established by these tests.

## Interactive CLI

Launch `namzu --output-schema /absolute/path/schema.json` to constrain each
main-query answer in the TUI through native output. The schema is loaded once
for that invocation and applies across model switches. It is not saved as a
global preference; the printed resume command carries the flag. Supply it yourself when using a different resume command. Unsupported providers
fail explicitly. Subagents keep their own output contracts.

The file must be an explicit object JSON Schema that round-trips through the
SDK's JSON Schema/Zod bridge without changing constraints. Include `properties`,
`required` and `additionalProperties`. Unrepresentable schemas are refused at
launch, rather than silently weakened. `$schema` at the root is metadata and
is not transmitted. Ordinary launches keep free-text answers.

A run's `timeoutMs` is checked between iterations. For bounded live probes use
an outer `AbortSignal` and `streamIdleTimeoutMs` as well; vendor request retries
and an open but silent stream must not be mistaken for completed inference.
