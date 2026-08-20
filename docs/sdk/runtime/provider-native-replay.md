---
uid: namzu.sdk.runtime.provider-native-replay
title: Provider-native replay ownership
description: Reference for assistant-message route provenance and versioned adapter replay state, including fallback attribution, resume behavior, validation, and safe degradation across provider or model switches.
type: Reference
diataxis: reference
owner: cogitave/namzu
status: active
timestamp: 2026-08-20T00:00:00Z
lastReviewed: 2026-08-20
resource: packages/sdk/src/types/message/index.ts
tags: [sdk, runtime, providers, reasoning, replay, fallback]
---

# Provider-native replay ownership

Some response metadata is meaningful only to the adapter that produced it.
Examples include signed thinking blocks, encrypted redacted blocks, and a
provider's native reasoning field. Treating readable reasoning text as enough
authority to rebuild those fields can make a model switch send foreign or
unsigned metadata as though the target model minted it.

Namzu separates the durable conversation from native replay evidence:

- `AssistantMessage.reasoning` remains the durable, provider-neutral record;
- `AssistantMessage.source` names the exact `ProviderRoute` that served the
  turn: `providerId`, `model`, and `chainIndex`;
- `AssistantMessage.source.replayState` is an optional, adapter-private,
  lossless-JSON envelope;
- `StreamChunk.replayState` and
  `ChatCompletionResponse.message.replayState` carry that envelope from a
  completed provider response into the settled message.

The SDK does not interpret `replayState`. The receiving adapter validates its
kind, schema version, embedded route, and correspondence with durable message
content before using it. Missing or unusable state means provider-neutral
history; matching provider/model names never reconstruct native state by
themselves.

## Route attribution

`query()` supplies `ChatCompletionParams.providerRoute` on every provider
request. The fallback decorator replaces it at final member dispatch, so a
response is not left attributed to the failed head. The settled assistant
message is stamped from the member that actually served the stream.

The same rule applies to the separate forced-final request used when a run
budget ends: its reasoning, citations, replay state, provenance, and cost all
belong to the member that answered that request.

A direct primary `chatStream` call may omit `providerRoute`; built-in adapters
then use their own provider id, the requested model, and chain index `0`.

## Resume and switching

Replay ownership is durable route identity, not JavaScript object lifetime.
Reconstructing a session after process restart is expected: if the historical
source and current target resolve to the same configured route and the envelope
validates, native metadata is restored exactly. This is what lets a signed or
reasoned tool-call continuation survive `/resume`.

Changing the provider, model, or fallback-chain member deliberately breaks that
native replay match. Assistant text, tool calls, and tool results remain in
history, while the target adapter omits the foreign native field. Malformed,
unknown-version, route-mismatched, or content-mismatched envelopes take the same
safe path.

Hosts that persist `Message[]` should preserve `source` and its opaque
`replayState` exactly. Hosts that validate stateless JSON history should validate
the route shape but leave envelope interpretation to the adapter that owns it.
