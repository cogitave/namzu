---
type: Reference
title: Local authenticated Pal channel adapters
description: CLI composition for private local channel fixtures over the shared SDK inbox and actual owned conversation logs.
resource: packages/cli/src/pals/channel.ts
tags: [cli, pals, channels, local]
status: draft
---

# Local authenticated Pal channel adapters

The CLI composes [SDK channel ingress](../sdk/pal-channels.md) through
`createCliPalChannel`. This is a trusted host adapter, not a new public webhook,
external account connection or `namzu pal channel` command. No external
transport, service login or message recipient is configured automatically.

The host supplies the captured connection, verifier, initial Pal selector,
current per-actor accept/receive/wake policy and separate reply/action policy.
Missing or denied authority cannot be inferred from the route's first sender.
The input's Namzu tenant is taken from the Pal's actual session storage; raw
events never select credentials or a native Namzu conversation.

Shared inbox records remain under `NAMZU_HOME/pal-message-inbox`. Immutable
channel target decisions live under `NAMZU_HOME/pal-channel-routes`. Both use
the CLI's current-user privacy hook on Windows and owner permissions on POSIX.
The host ensures the exact Pal/profile claim using normal conversation storage;
it does not replace the Pal root origin with a channel origin or inherit a
different session's history. No host control directory is mounted into a guest.

`source(binding)` returns the common durable query source and rejects another
input family or connection. The host must explicitly provide ordinary Pal query
execution and real virtual-computer admission; the adapter never constructs a
model or guest to accept a message. An absent dispatcher refuses execution.
Execution policy must continue checking the triggering actor's current authority
before provider requests and guest effects.

## Private local authentication fixture

`createCliPalLocalChannelVerifier({ connection, secret })` accepts only an exact
`{ payload, signature }` envelope. The secret must contain at least 32 bytes and
is captured privately. `payload` is the exact serialized JSON event;
`signature` is lowercase hexadecimal HMAC-SHA256 over:

```text
namzu-local-channel/1\0<JSON([tenantId,provider,connectionId,externalTenantId])>\0<payload>
```

The separators above represent actual NUL bytes. Authentication covers the
captured connection and every payload byte. Extra credential selectors,
changed actors/content and another connection are rejected. The authenticated
result is then strictly validated by the SDK and separately authorized for its
current actor. Possession of the local fixture key is not an actor permission.
Keep the key in the host; do not place it in model input, a guest volume or a
renderer message. This fixture proves local ingress wiring; it does not claim
provider-specific remote authentication.

## Recorded replies and review actions

The adapter exposes `router` for exact recorded response routing. Resolution
returns the original native destination and actual log receipt. Sending a remote
response requires a separately implemented transport and durable effect journal;
there is no automatic remote-send retry.

`createCliPalChannelActions` connects a supported authenticated JSON
`{ waiting, answer }` payload to `createCliPalReviewActions`. The payload cannot
set its actor, connection or operation identity. The waiting session and turn
must match the original recorded channel delivery. The native gate verifies the
actual pending tool-review request/checkpoint, current consent, Pal ownership
and pause, then durably reserves the exact decision before real parked resume.
The host must supply `currentPermissionMode` from the actual session's current
mode; channel payloads cannot change it or bypass a plan-mode write restriction.
Duplicate actions require the same immutable intent and confirmed resolution
record; uncertain effects require reconciliation. Supported answers are only
`approve_once` and `reject` with feedback. A host without this action port refuses
execution explicitly.
