---
uid: namzu.sdk.runtime.duplex-run-lifetime
title: Duplex run lifetime
description: Reference for duplex-session ownership, the difference between conversational interruption and run cancellation, atomic tool-result publication, duplicate-call fencing, and bounded provider cleanup.
type: Reference
diataxis: reference
owner: cogitave/namzu
status: active
timestamp: 2026-08-30T00:00:00Z
lastReviewed: 2026-08-30
resource: packages/sdk/src/runtime/bidi/session.ts
tags: [sdk, runtime, duplex, cancellation, tools]
---

# Duplex run lifetime

`startBidiRun()` owns one provider session and every tool call admitted from
that session. Its optional `signal` covers the whole lifetime: connection,
input, provider events and tool contexts. A pre-aborted signal refuses before
calling the provider. An abort while `connect()` is pending rejects with the
caller's exact reason, even when the provider ignores its signal; a session
that arrives after that boundary is closed and is never published as a run.

## Interruption is not cancellation

A provider `interrupted` event says the conversation moved on while a tool was
running. It advances the conversation generation but does not abort the tool
context. This lets an irreversible operation finish instead of stopping at an
unknown halfway state. If its result has not begun publication, Namzu emits
`tool_abandoned` and does not send that stale result.

Entering `BidiSession.sendToolResult()` is the atomic publication boundary. A
later conversational interruption cannot recall a result already handed to
the provider. Providers resolve that promise only after accepting the result
and reject it when publication did not happen.

Run cancellation is different. Caller abort, explicit `close()`, an unexpected
event-stream end and a far-side `closed` event synchronously fence local event
and tool admission and abort the signal in every active tool context. No
terminal tool event is published after the fence. Tool implementations must
still observe their context signal; JavaScript cannot terminate arbitrary code
that ignores cooperative cancellation.

## Provider cleanup

`BidiRun.close()` invokes the provider session's `close()` at most once. Local
fencing happens before that promise is observed, so a held transport cannot
keep the event stream or tool authority open. Provider cleanup is bounded by
`closeTimeoutMs`, which defaults to 5,000 ms:

```ts
import {
  startBidiRun,
  type BidiProvider,
  type ToolRegistryContract,
} from '@namzu/sdk'

declare const provider: BidiProvider
declare const tools: ToolRegistryContract

const run = await startBidiRun({
  provider,
  tools,
  connect: { model: 'voice-model' },
  workingDirectory: '/workspace',
  closeTimeoutMs: 10_000,
})
```

The bound must be an integer from `0` through `2,147,483,647`. Set it to `0`
only when an unbounded provider-close wait is an intentional compatibility
choice. A bound that expires throws `BidiSessionCloseTimeoutError`: the local
run is already fenced, but provider cleanup remains unconfirmed.

## Tool-call identity

A tool-call id is unique for the complete provider session. Repeating an id
would otherwise execute a side effect twice. Namzu emits the existing `error`
event, closes the session and never admits the duplicate. The event union does
not gain a second protocol-only terminal shape, so existing exhaustive
consumers remain source compatible.
