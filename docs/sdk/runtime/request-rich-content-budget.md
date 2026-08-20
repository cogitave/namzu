---
uid: namzu.sdk.runtime.request-rich-content-budget
title: Provider request rich-content budgets
description: Reference for the accumulated inline image and document budget applied to provider requests, its oldest-first projection, preserved run history, front-door configuration, and explicit unbounded compatibility mode.
type: Reference
diataxis: reference
owner: cogitave/namzu
status: active
timestamp: 2026-08-20T00:00:00Z
lastReviewed: 2026-08-20
resource: packages/sdk/src/runtime/query/request-rich-content.ts
tags: [sdk, runtime, providers, images, documents, tools]
---

# Provider request rich-content budgets

An inline image or PDF is sent again with every later model request in the
same conversation. Rich tool results behave the same way: a sequence of
individually reasonable screenshots can accumulate into a request that the
provider gateway rejects, after which every continuation resends the same
oversized history.

`query()` therefore limits the accumulated base64 payload in one provider
request. The shipped default is
`DEFAULT_MAX_REQUEST_RICH_CONTENT_BYTES`, currently **24 MiB**. The effective
value is written to `Run.metadata.config`, including when the caller relied on
the default.

## Configure the budget

`maxRequestRichContentBytes` is available on `AgentRunConfig`, the ergonomic
agent configs, `runAgent()` options, and directory `agent.ts` config.

```ts
import { runAgent, type LLMProvider } from '@namzu/sdk'

declare const provider: LLMProvider

await runAgent({
  provider,
  model: 'model-id',
  prompt: 'Compare the attached reports.',
  maxRequestRichContentBytes: 12 * 1024 * 1024,
})
```

Values are base64 characters/bytes, before JSON framing. Base64 is ASCII, so
the two measures are equal. This is a rich-content budget, not a promise about
the size of the complete HTTP body: text, schemas, headers, and JSON syntax are
outside it.

The value must be a non-negative safe integer. Negative, fractional,
non-finite, and unsafe values are refused before a run id or provider request
is created. Set `0` only to retain the earlier unbounded behavior:

```ts
import { runAgent, type LLMProvider } from '@namzu/sdk'

declare const provider: LLMProvider

await runAgent({
  provider,
  model: 'model-id',
  prompt: 'The host gateway owns an equivalent request limit.',
  maxRequestRichContentBytes: 0,
})
```

## What shares the budget

One chronological budget covers every provider-bound inline payload:

- image and document attachments on user messages;
- image and document blocks inside tool-result messages.

When their total exceeds the limit, the runtime replaces the oldest payloads
until the remainder fits. A user attachment becomes a model-visible omission
marker appended to that user message. A rich tool block becomes a text block
in the same position. Newer payloads remain exact when their combined size
fits; one payload larger than the whole budget is omitted as well.

The runtime never removes a tool-result message or its `toolCallId`, so the
assistant call/result sequence remains valid for providers. Omission markers
tell the model how to reacquire the value instead of making an absent image
look like a text-only result.

## Projection, not history editing

The budget builds a request-only projection immediately before each ordinary
model call and before the separate limit-closing call. It does not edit:

- `Run.messages`;
- durable run messages or checkpoints;
- compaction input;
- a host's conversation history.

Each later request is projected again from that canonical history, so markers
do not accumulate between turns. The `pre_llm_call` hook receives the same
projected messages the provider receives.

Stored attachment references are resolved before this step. An unresolved
reference is still refused; the budget cannot turn missing storage authority
into an omission marker.

`maxToolContentBytes` is a separate, opt-in cap on one tool result at the
moment it is produced. `maxRequestRichContentBytes` is the default-on,
conversation-wide provider request bound. Setting one does not replace the
other.
