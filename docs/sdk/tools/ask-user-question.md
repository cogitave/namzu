---
title: The ask_user_question tool
description: Give a run one tool that turns to the human for a decision, built alone from a park handler without the coordinator's gateway, roster, or a run id chosen before any run exists.
type: Reference
status: stable
resource: packages/sdk/src/tools/coordinator/ask-user-question.ts
tags: [sdk, tools, hitl]
generated: { by: human:bahadirarda, at: 2026-09-02T00:00:00Z }
---

# The `ask_user_question` tool

`ask_user_question` lets the model ask the person one question with two to
four options when a decision is genuinely theirs. The run parks on the
question and resumes with the answer, or with a sentinel saying there was
none.

## Build it alone

```ts
import { buildAskUserQuestionTool, type ResumeHandler } from '@namzu/sdk'

const resumeHandler: ResumeHandler = async (request) => {
  // Show request.question to the person; return their decision.
  return { action: 'abort', reason: 'no interactive surface' }
}

const askUserQuestion = buildAskUserQuestionTool({ resumeHandler })
```

| Option | Meaning |
| --- | --- |
| `resumeHandler` | Where the question goes. The run parks on the returned promise. |
| `runId` | Pin the run the park is recorded against. Omitted, the tool uses the `runId` of the call that asked. |
| `questionParks` | A durable recorder, so a remote host can observe the question. |
| `pendingAnswers` | Answers carried in by a resumed run, consulted before parking again. |

`buildCoordinatorTools` registers the same tool through this builder when it
is given a `resumeHandler` and a `runId`; a host that wants only the question
— an interactive terminal with no delegation — calls the builder directly.

## What the model sees

The tool's `modelInputSchema` is closed (`additionalProperties: false`) with
`options` as an array of `{ label, description? }`; a provider that
constrains generation to the schema cannot serialize the array into a string.
The result quotes the question and the selected labels verbatim, with a
trailing ` (Recommended)` stripped from a label. If the person did not
answer, the result says so and the model is told not to ask again.

## Related

- [Tool safety](./safety.md)
