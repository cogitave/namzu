---
title: The Anthropic driver — authentication, configuration and strict tool inputs
description: Reference for @namzu/anthropic — authentication, configuration, route-bound signed-thinking replay, reasoning effort mapping, and strict tool-input generation.
type: Reference
status: stable
resource: packages/providers/anthropic/src/client.ts
tags: [provider, anthropic, reference]
generated: { by: human:bahadirarda, at: 2026-08-23T00:00:00Z }
---

# The Anthropic driver

One of the model drivers for the kernel. It wraps the vendor's official SDK and
implements `LLMProvider`, so the kernel drives it through the same interface as
every other driver and nothing above the driver layer knows which vendor is
answering.

Installed only if you use it. The kernel has no preferred vendor and no driver
is a dependency of it.

## Authentication

Exactly one of `apiKey` or `authToken` must be set.

| Field | For |
|---|---|
| `apiKey` | a console key, sent as `x-api-key` |
| `authToken` | an OAuth access token, sent as `Authorization: Bearer …` |

Conventionally the key comes from `ANTHROPIC_API_KEY`. The kernel's credential
vault can hold it instead, so it never has to reach the driver's config as a
plain string.

The OAuth branch also carries the beta, CLI application and user-agent identity
required to route a plan-backed token as subscription inference. Those signals
are not added to the API-key branch, whose requests retain normal Namzu
attribution.

They are mutually exclusive rather than merged: two credentials on one request
means whichever the transport prefers decides which identity the call is billed
and attributed to, and that is not something a config should leave ambiguous.

## Configuration

| Option | Default | Notes |
|---|---|---|
| `apiKey` | — | mutually exclusive with `authToken` |
| `authToken` | — | OAuth bearer token |
| `model` | — | default model when a call omits one |
| `maxTokens` | `64000` | the Messages API requires the field; this is the fallback |
| `baseURL` | vendor default | a proxy or a compatible gateway |
| `timeout` | SDK default | request timeout, ms |
| `streamIdleTimeoutMs` | disabled | per-event idle watchdog, for failing a stalled stream independently of the request timeout |
| `defaultHeaders` | — | appended to every request |
| `strictToolUse` | `'auto'` | see below |

For AWS Bedrock or Vertex access prefer the dedicated driver over a `baseURL`
override — they carry the auth and region semantics natively.

## Streaming is the only entry point

`LLMProvider` has **one** model entry point, `chatStream`. A non-streaming call
is that stream collected:

```ts
import { ProviderRegistry, collectChatCompletion } from '@namzu/sdk'
import { registerAnthropic } from '@namzu/anthropic'

import type { Message } from '@namzu/sdk'

declare const messages: Message[]

registerAnthropic()

const { provider } = ProviderRegistry.create({
  type: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-sonnet-4-5-20250929',
})

const response = await collectChatCompletion(
  provider.chatStream({
    model: 'claude-sonnet-4-5-20250929',
    messages: [{ role: 'user', content: 'Hello' }],
  }),
)
```

Or consume it as it arrives:

```ts
import type { LLMProvider } from '@namzu/sdk'

import type { Message } from '@namzu/sdk'

declare const messages: Message[]

declare const provider: LLMProvider

for await (const chunk of provider.chatStream({
  model: 'claude-sonnet-4-5-20250929',
  messages: [{ role: 'user', content: 'Tell me a story' }],
})) {
  if (chunk.delta.content) process.stdout.write(chunk.delta.content)
}
```

In practice you rarely call the driver directly — the kernel's run loop does,
and hands you events. This is the shape when you do.

## Model menu and credential probe

`listModels(signal)` builds a menu and may fall back to the driver's known
catalogue when the vendor listing is unavailable. `probeCredential(signal)` is
separate and never uses that fallback: it must make an authenticated request or
throw, because a menu is not evidence that a credential worked. Both optional
signals reach the vendor request and are rechecked before a result is returned.

## Extended thinking

`resolveEffort`, `resolveThinkingBody` and `resolveThinkingCapability` are
exported so a host can see how a requested reasoning effort maps onto the
vendor's thinking parameters **before** a call is made, rather than inferring it
from the response.

`reasoningEffortLevelsFor(model, thinking)` publishes that same exact menu
through `LLMProvider`; the older `effortLevelsFor` spelling remains as a
deprecated compatibility alias. A selected level outside the menu is refused
before the vendor client is called, with the supported levels in the error.
It is never silently dropped to the model default. When a request omits its
model, both validation and the request body use the provider's configured
default model.

### Signed-thinking replay

Native thinking blocks carry signatures or encrypted redacted payloads that
must be returned byte-for-byte and before the assistant text/tool call. The run
loop therefore stores durable reasoning together with a versioned replay
envelope and the exact `ProviderRoute` that produced it: provider id, model, and
fallback-chain index.

The driver restores native blocks only when the source route, envelope route,
schema version, and durable block sequence all agree with the route now
receiving the request. This survives process restart and `/resume` on the same
configured route. A model/provider/member switch, an unsigned legacy block, or
missing/malformed/edited state keeps the assistant text and tool exchange but
does not impersonate signed thinking from another route.

`query()` owns the stamping automatically. A direct `chatStream` host must keep
the completed stream's `replayState` with the corresponding assistant source;
provider/model names by themselves are not replay authority.

## Strict tool inputs

A tool that declares `modelInputSchema` **and** `enforceModelInput: true` is
sent with strict generation on recognised Claude 4.5+ models, which constrains
generation to the schema instead of validating after the fact.

`strictToolUse` decides when that happens:

| Value | Behaviour |
|---|---|
| `'auto'` (default) | enabled for known model identifiers |
| `'on'` | opts a compatible proxy alias in |
| `'off'` | disabled |

Zod validation still runs on every tool call either way — strict generation
narrows what the model can emit; it does not replace the check.

Every custom tool reaches the Messages wire as a root object schema. When a
renderer expresses a conditional input as root `anyOf`, `oneOf`, or `allOf`,
adding `type: "object"` beside it is not sufficient: the Messages wire rejects
the whole request. The driver therefore refuses every root combinator locally,
names the tool and keyword, and points the author to `modelInputSchema`.

Use a flat object `modelInputSchema` for the fields a model may emit and keep
branch-specific required-field checks in the runtime `inputSchema`. Nested
combinators remain available, subject to the strict subset below; this rule is
only about the custom input schema's root.

The kernel refuses a schema outside the strict subset at registration rather
than sending it, because the vendor rejects the whole request when one keyword
is unexpressible and the turn dies before a token is produced.

## Capabilities

```ts
import { ANTHROPIC_CAPABILITIES } from '@namzu/anthropic'

// {
//   supportsTools: true,
//   supportsStreaming: true,
//   supportsFunctionCalling: true,
//   supportsVision: true,
//   supportsDocuments: true,
//   supportsToolResultImages: true,
//   supportsToolResultDocuments: false,
// }
console.log(ANTHROPIC_CAPABILITIES.supportsVision)
```

The last two declarations are deliberately separate from user attachments.
This driver projects an image returned by a tool as native rich result content,
but it has no corresponding document-result mapping. With strict capability
checking, the runtime therefore permits the former and refuses the latter
before another model request is made.

## Observability

Spans and metrics come from the kernel, not from this package — it is a driver,
and instrumenting each one separately would report the same call under as many
names as there are vendors. Install `@namzu/telemetry` to export them.
