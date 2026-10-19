---
type: Guide
title: When a turn acquires its sandbox
description: The turnConfig.sandbox.acquire option, which takes sandbox acquisition off the first-token path ('concurrent') or defers it to the first tool call ('on-first-use'), what a tool, a failure, a timeout and an abort see in each mode, and when sandbox_created is emitted.
resource: packages/sdk/src/runtime/query/deferred-sandbox.ts
tags: [sdk, sandbox, latency, lifecycle]
status: stable
generated: { by: human:bahadirarda, at: 2026-10-19T00:00:00Z }
---

# When a turn acquires its sandbox

A turn with a `sandboxProvider` used to await `acquireSandbox` and only then run
the input guardrails and send the first model request. The model request does
not depend on the sandbox: nothing executes in it until a tool call arrives,
which is at the earliest after the first response has streamed. With a
provider whose allocation takes a second or more, that second sat in front of
the first token of every turn, including turns that never call a tool.

`turnConfig.sandbox.acquire` chooses when the turn pays for it.

```ts
import type { QueryParams } from '@namzu/sdk'

const turnConfig: QueryParams['turnConfig'] = {
  model: 'my-model',
  timeoutMs: 120_000,
  tokenBudget: 200_000,
  // Allocate while the first model request is in flight.
  sandbox: { acquire: 'concurrent' },
}
```

| Value | Acquisition starts | The turn waits for it |
|---|---|---|
| `'eager'` (default) | before the input guardrails | before the first model request |
| `'concurrent'` | at the same point | at the first tool call, or at turn end if none comes |
| `'on-first-use'` | at the first tool call | at that tool call |

`'eager'` is what every sandboxed turn did before the option existed; leaving it
out changes nothing, including the order of events.

## What the modes keep

- **Tools.** The first tool batch waits for the acquisition before it is
  reviewed or run, so a tool never sees a missing sandbox, and the review
  treats the turn as sandboxed from the start. The wait is the acquisition
  itself: it is bounded by what is left of the turn timeout and cancelled by the
  turn's abort signal, as an eager acquisition is.
- **Failure and timeout.** The turn ends with the stop reason and events an
  eager acquisition produces: `cancelled`, `timeout`, or the provider's own
  error. It happens at the first moment a tool needs the sandbox or at turn end,
  whichever comes first. A model request that already went out is not undone,
  and a turn that fails this way may have spent one. When the acquisition was
  cancelled or ran out of time, the iteration that found out is recorded as a
  `cancelled` step (it keeps the tokens it spent) with no error span and no
  failed activity, so the step ledger and the `cancelled` / `timeout` stop
  reason agree, as they do for a turn stopped by its own abort or timeout. A
  provider failure is still an `error` step. The assistant message that asked for
  the tools stays in history without results; the next turn's history repair
  (`repairToolMessageHistory`) resolves it, so a follow-up never sends the provider an
  unpaired tool call.
- **A bad value.** An `acquire` other than the three above fails the turn with
  `invalid_config` before anything is started, whether or not the turn has a
  `sandboxProvider`.
- **A turn that never uses the sandbox** still settles the acquisition before it
  completes (`'concurrent'`), so a failure is reported rather than lost.
  `'on-first-use'` never starts one, and a tool-less turn never calls the
  provider.
- **`sandbox_created`** is emitted when the acquisition resolves, not when it
  starts. With `'concurrent'` it can therefore come after the first model
  response has begun; a consumer that needs the handle waits for the event.
- **Teardown.** A turn that stops while the acquisition is pending withdraws
  it. A handle that arrives afterwards is released by the same late-teardown path
  an eager turn uses (`sandboxTeardownTimeoutMs` bounds it), so nothing stays
  allocated.

## Choosing

Use `'concurrent'` when most turns use the sandbox and the provider is slow to
allocate: the first token no longer waits for it. Use `'on-first-use'` when many
turns never touch one and a sandbox costs something to hold. Keep `'eager'`
when a failed acquisition must stop the turn before any model spend.
