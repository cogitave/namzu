---
title: The AWS Bedrock driver — model ids, credentials and prompt caching
description: Reference for @namzu/bedrock: how a Bedrock model id differs from a vendor id, where credentials and region come from, what prompt caching buys and costs, and the health and error surfaces the kernel reads.
type: Reference
status: stable
resource: packages/providers/bedrock/src/index.ts
tags: [provider, bedrock, reference]
generated: { by: human:bahadirarda, at: 2026-08-17T00:00:00Z }
---

# The AWS Bedrock driver — model ids, credentials and prompt caching


One driver, one wire. `BedrockProvider` implements the kernel's `LLMProvider`
contract on top of `@aws-sdk/client-bedrock-runtime`, and it sends exactly one
command: `ConverseStream`. There is no non-streaming path, because the contract
has no non-streaming method — `chatStream` is the single model entry point, and
a caller who wants the whole answer collects the stream.

It is a separate package so a consumer who never calls Bedrock does not carry
the AWS SDK client to use none of it. `@namzu/sdk` is a peer dependency
(`>=6.0.0`), so your lockfile owns the kernel version rather than this package.


## Use it

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerBedrock } from '@namzu/bedrock'

import type { Message } from '@namzu/sdk'

declare const messages: Message[]

registerBedrock() // once, at startup

const { provider } = ProviderRegistry.create({
  type: 'bedrock',
  region: 'us-east-1',
})

for await (const chunk of provider.chatStream({
  model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  messages: [{ role: 'user', content: 'Hello' }],
})) {
  if (chunk.delta.content) process.stdout.write(chunk.delta.content)
}
```

`registerBedrock()` also carries the module augmentation that adds `'bedrock'`
to the kernel's config union, so `ProviderRegistry.create({ type: 'bedrock',
… })` narrows to `BedrockProviderConfig` and typos in the config are compile
errors. Call it twice and it throws `DuplicateProviderError`; pass
`{ replace: true }` when you mean to take the slot over.

When you want the aggregated response rather than the deltas, collect the same
stream:

```ts
import { collectChatCompletion } from '@namzu/sdk'

import type { BedrockProvider } from '@namzu/bedrock'
import type { Message } from '@namzu/sdk'

declare const provider: BedrockProvider
declare const messages: Message[]

const response = await collectChatCompletion(
  provider.chatStream({
    model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    messages: [{ role: 'user', content: 'Hello' }],
  }),
)

console.log(response.message.content)
console.log(response.usage.totalTokens)
```

This driver is constructed by your own code, not by the terminal agent:
`@namzu/cli` does not depend on this package, and its provider table records
`bedrock` as one that build cannot construct.

## Model ids

Converse serves **ARN-versioned** model ids —
`anthropic.claude-sonnet-4-5-20250929-v1:0` — usually behind an
inference-profile prefix (`global.`, `us.`, `eu.`, `jp.`, `apac.`). A Claude id
carrying no version suffix belongs to a newer Bedrock integration that speaks a
different request shape at a different endpoint, and this driver cannot reach
it.

So an unreachable id is refused locally, before any AWS call, with the reason
and the fix in the message — rather than sent and answered by an opaque
validation error that names neither:

```ts
import type { BedrockProvider } from '@namzu/bedrock'

import type { Message } from '@namzu/sdk'

declare const driver: BedrockProvider
declare const messages: Message[]

declare const provider: BedrockProvider

provider.chatStream({ model: 'anthropic.claude-opus-5', messages })
// Error: This driver cannot reach "anthropic.claude-opus-5". It speaks
// Bedrock's Converse API, which serves ARN-versioned model ids such as
// "us.anthropic.claude-sonnet-4-5-20250929-v1:0" …
```

The rule reads the id's **shape**, not a list of models. A new ARN-versioned id
passes without this package changing, which is the correct failure direction for
a list that will go stale. Only unversioned Claude ids are refused, and only
Claude ones: Converse is a multi-vendor wire and the other vendors' ids are
governed by nothing here.

`listModels()` returns a small hand-written menu, so an operator with no network
still has something to pick from:

```ts
import type { BedrockProvider } from '@namzu/bedrock'

declare const provider: BedrockProvider

await provider.listModels()
// anthropic.claude-sonnet-4-20250514-v1:0   Claude Sonnet 4 (Bedrock)
// anthropic.claude-haiku-4-5-20251001-v1:0  Claude Haiku 4.5 (Bedrock)
// amazon.nova-pro-v1:0                      Amazon Nova Pro
```

Its `inputPrice` and `outputPrice` are display data. The kernel's price
catalogue has no `bedrock` vendor, so `resolveModelPricing('bedrock', …)`
resolves nothing and no run through this driver is costed from those numbers.

## Credentials and region

Explicit credentials win, and only when both halves are present: pass
`accessKeyId` **and** `secretAccessKey` — plus `sessionToken` for temporary
credentials — and the driver hands them to the client. Pass neither, or only one
of the two, and the AWS default credential chain runs instead: environment
variables, the shared config and credentials files, SSO profiles, and the
instance role on EC2, ECS and Lambda. That is the useful case on AWS compute,
where the role supplies the credential and the config should stay empty.

`region` works the same way — set it, or leave it out and let the AWS SDK read
`AWS_REGION` / `AWS_DEFAULT_REGION`. Bedrock is region-scoped and model access
is enabled per account and per region, so a valid credential pointed at the
wrong region still fails. It fails as `unknown-model` rather than `credentials`,
which is exactly the distinction the health report exists to make.

| Option | Default | Notes |
|---|---|---|
| `region` | AWS SDK default (`AWS_REGION` / `AWS_DEFAULT_REGION`) | Bedrock is region-scoped |
| `accessKeyId` | — | applied only together with `secretAccessKey` |
| `secretAccessKey` | — | applied only together with `accessKeyId` |
| `sessionToken` | — | temporary credentials; carried only alongside the two above |
| `timeout` | `120_000` | per-request timeout in ms |

That is the whole of `BedrockConfig`. There is deliberately no `endpoint`, no
`baseUrl` and no `requestHandler`: this driver exposes no HTTP seam of its own,
which is why its tests substitute the AWS client rather than the transport.

## Prompt caching

Caching on this wire is not a flag on the request — it is a marker spliced into
the content, and a request without one is uncached however the caller configured
it. When `cacheControl` is set and the model is one Anthropic serves here, the
request carries three cache points: after the last tool schema, after the last
system message tagged `cacheHint: 'cache'`, and after the last content block of
the last message. The prompt is assembled tools → system → messages, so each
later point also covers everything before it.

The system point goes after the **static** block rather than at the end of the
array. A marker placed after the per-run dynamic text would pin a prefix that
changes every run, so every read would miss and every write would be billed —
cache writes forever, cache reads never.

The gate is the model family, not the wire. Converse carries several vendors,
prompt caching is a property of the models on it, and a cache point sent to a
model that does not take one is rejected outright — the whole request, not just
the caching. A model outside the gate sends exactly the bytes it sent before and
`cacheControl` has no effect on it.

Usage arrives on its own chunk, from the stream's metadata event: `cachedTokens`
is what was read from the cache and `cacheWriteTokens` what was written to it.
Expect writes on the first turn of a stable prefix, priced above ordinary input,
and reads on the turns after, priced below it.

## Capabilities

```ts
import { BEDROCK_CAPABILITIES } from '@namzu/bedrock'

// {
//   supportsTools: true,
//   supportsStreaming: true,
//   supportsFunctionCalling: true,
//   supportsVision: false,
//   supportsDocuments: false,
// }
```

These describe what this **driver** does, not what Bedrock could do, and the
runtime reads them before the request is built — it warns, or fails under
`strictCapabilities`, rather than letting content vanish quietly. So the two
`false` entries are load-bearing: a user message's image `attachments` are not
mapped and never reach the model, and an image inside a tool result becomes a
named placeholder rather than a wall of quoted base64 that is unreadable and
billed by the character.

Tools are mapped in both directions, including tool results and the assistant
turns that called them. When history references a tool the caller no longer
passes, a placeholder spec is minted so the wire stays happy; those placeholders
are deliberately left outside the cached prefix, because they are not the
caller's tool set.

Tool input schemas follow the model rather than the endpoint: an Anthropic-served
id gets JSON Schema 2020-12, everything else on the wire gets draft-07. Claude
reached through Converse is still Claude, and its serving layer validates the
schema whichever front door the request came through.

`toolChoice: 'none'` omits the tool block entirely instead of mapping to the
wire's `auto`, which means the opposite. No wire format lets a model call a tool
it was never given.

Extended thinking and `effort` are not implemented here, and they are **refused**
rather than dropped — setting either throws before the request is built. A
silently ignored `effort` returns an ordinary completion indistinguishable from
the model's default, including on the bill.

## Health

`doctorCheck(model)` sends one `ConverseStream` request for one token and reports
what it learned:

```ts
import type { BedrockProvider } from '@namzu/bedrock'

declare const provider: BedrockProvider

const report = await provider.doctorCheck(
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
)

report.status // 'pass' | 'fail' | 'warn' | 'skipped' | 'inconclusive'
report.reason // 'ok' | 'credentials' | 'unknown-model' | 'throttled' | …
```

The reason is the point, and it is named for what an operator does next.
`no-credentials` is a machine that resolved nothing to send; `credentials` is
AWS looking at one and refusing it; `unknown-model` is a well-formed id this
region does not serve; `unreachable-model` is this driver's own rule refusing
before a packet leaves; `throttled` is `warn`, because the service is up but the
probe did not complete; and `unreachable-service` is `inconclusive` rather than
`fail`, because telling an operator on broken wifi that Bedrock is down sends
them to the wrong place. Where there is something to do about it, the report
carries a `remediation` sentence.

`BedrockHealthReport` extends `DoctorCheckResult`, so a doctor run reads `status`
and never sees the extra field, while a caller holding the concrete driver reads
`reason` without a cast.

The probe uses `ConverseStream` and not `Converse` because that is the command
the request path sends, and the two are separate IAM actions — a probe on the
other one can pass under a policy every real call fails under, which is a green
check about a request nobody makes.

`healthCheck(model)` is the same probe reduced to one bit. Pass the model you
actually run: this driver's config holds no model, so with nothing passed there
is nothing to probe and the answer is `false` for the stated reason `no-model`
rather than for a guessed one.

## Errors

Every failure this driver raises is a `ProviderRequestError` from `@namzu/sdk`,
classified from the AWS exception class into the kernel's own kinds —
`throttle`, `auth`, `bad_request`, `context_overflow`, `server`, `network` — so a
caller can decide whether to retry, compact or give up without importing
`@aws-sdk/client-bedrock-runtime`. The vendor error is dropped rather than
re-thrown or attached as `cause`: AWS builds its exception message from the
response body, so a credential the service echoed back is inside that message
before this code sees it.

Bedrock also reports several post-handshake failures as members of the stream's
output union rather than as throws, after a 200. Those are read and raised too,
because ignoring them makes a throttled or failed stream look like a clean EOF.

`params.signal` is passed to the AWS client and checked between events, so a stop
tears the in-flight stream down mid-turn instead of waiting for it to end, and
the caller's own abort reason is what surfaces.
