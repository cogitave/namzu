---
type: Reference
title: Structured output review
description: Host validation of parsed structured results, bounded corrections and checkpoint recovery.
resource: packages/sdk/src/types/structured-output/index.ts
tags: [sdk, harness, verification]
---

# Structured output review

`QueryParams.structuredOutput.review` checks the parsed result after the output
tool has validated its schema and before `Run.structuredOutput` is published.
The callback receives a cloned JSON-decoded value (`unknown`) and an `AnswerReviewContext` containing
run identity, iteration, messages and the run's cancellation signal. Mutating
that clone does not change the published result. Narrow or validate the value
before use: JSON serialization can change schema output types (for example,
Dates become strings). The kernel does not rerun schema transforms during review.

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

Thrown errors and malformed verdicts fail the run. Cancellation stops waiting
for the reviewer, even if its promise does not settle; external work started by
the callback must still honor the supplied signal. Only a solitary successful
output-tool call is reviewed for settlement; a candidate alongside other calls
is relayed until the model has observed their results.

A rejection saves feedback and `IterationCheckpoint.structuredReviewAttempts`
before the next model request. Resume restores that counter independently of
message compaction. Supply the same review configuration when resuming. This is
checkpoint state, not a tamper-proof lifetime quota: selecting an older checkpoint
restores its older counter, and changing the host policy changes the allowance.
The callback itself is host code and is not serialized.

This API uses the existing output-tool constraint. It does not enable a provider's
native response-format mode. Existing prose `reviewAnswer` behavior is unchanged.

Review reads the retained tool-result JSON, not a separate result artifact. The
default tool-output budget is 40,000 characters. A truncated or transformed
receipt that is no longer JSON fails before review; it cannot be accepted as
validated output. Hosts expecting larger results must raise `maxToolOutputChars`
(or explicitly set zero to disable that cap) and budget model context accordingly.
A separate durable structured-result channel remains future work.
