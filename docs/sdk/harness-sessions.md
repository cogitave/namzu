---
type: Reference
title: External harness sessions
description: Durable, owned sessions whose execution and tools belong to a host-composed external engine.
resource: packages/sdk/src/runtime/harness-session/index.ts
tags: [sdk, sessions, persistence, harnesses, permissions]
status: stable
---

# External harness sessions

`createHarnessSession` manages a conversation executed by a host-supplied
`HarnessAdapter`. An adapter owns the external engine's tools and native
session. It is not an `LLMProvider`: the SDK does not run its operations through
`query()` or `ToolExecutor`, mint tool grants, or replay Namzu conversation
history as new vendor prompts. Existing Namzu execution is unchanged.

The CLI may compose installed Codex app-server or `claude` stream-json
adapters. Their executables, accounts and installed protocol versions belong to
the host. The SDK imports no vendor code and discovers no credentials.

## Binding and admission

The factory requires an exact `HarnessScope`, a `SessionLog`, an adapter, an
`assertAdmission` callback and event/review callbacks. The admission callback
must establish the current actor, ordinary project ownership, canonical native
execution directory and applicable trust before open, run, approval and
reconnect. A host must refuse Pal sessions and Pal metadata workspaces: an
external engine has no Pal guest admission and must not execute a Pal on the
host computer.

The original `session_started.harness` records `{v:1, engineId, profileRef,
nativeSessionId, cwd, initialModel}`. `profileRef` is an opaque, host-owned
identity for executable and account/state-home selection; never a token or raw
credential. The binding is immutable. Opening refuses existing Namzu sessions,
foreign tenant/project/topic attribution, a changed engine/profile/cwd, and
native session replacement. Validation happens before writer acquisition or
repair and again under the real journal lease.

The reverse boundary is also enforced: `query()`, `resumeSession` and
`TurnRecorder.open` refuse a journal whose original start records an external
harness. They reject before kernel provider, tool, budget or queued-message
work and recheck after acquiring the writer. Continue through the recorded
harness, or start a separate Namzu session. Owned durable history remains
readable without starting either engine.

Native identifiers remain opaque. They are not parsed as Namzu UUIDs or passed
to external alias lookup. An engine without native turn identifiers may use
`turnIdSource:'operation'`, provided its correlation exactly equals the SDK's
persisted dispatch operation ID. That source is an adapter correlation, not a
claim that the engine returned a native turn ID.

## Durable dispatch and observations

The SDK reserves one turn, writes the authored prompt and a
`session_updated.harness` dispatch receipt, and rechecks admission and its
writer before native dispatch. The receipt captures the actual model, effort
when present, and permission mode. The SDK never silently changes engines or
resends an uncertain prompt. Hosts can read `currentTurnId` for exact Stop
ownership; concurrent prompt admission is refused and visible queues remain a
host concern.

Subscribe through `HarnessAdapter.open` before spawning or opening the native
session. Events arriving before the returned binding are bounded and held
until that binding is verified. Native turn completion may arrive before the
dispatch acknowledgement; the late acknowledgement cannot revive it.

Native items map to host-minted Namzu message/tool IDs scoped to their bound
turn. Distinct native messages with identical text remain distinct. A complete
native assistant item replaces its earlier streamed text under the same Namzu
ID, and an authoritative correction replaces that durable message. Native tool
events are observations attributed with the engine's tool-name namespace;
they do not claim Namzu tool admission, authorization or execution.

Existing public message/reasoning events use transcript segment `iteration:0`.
There is no invented kernel `iteration_started` or model-call count. Existing
mandatory settlement usage, cost and iteration counters describe Namzu kernel
execution, which is zero here; vendor token usage, billing and native internal
iterations are unavailable through this initial port. Do not display those
zeros as evidence of free external inference. The recorded zero token-budget
and timeout fields introduce no vendor resource limit.

`history()` reads owned durable public text without starting an engine. Raw
vendor frames, signatures and private replay state are excluded from the
adapter event contract; only documented public reasoning text may enter it.

## Native reviews and Stop

`onReview` presents the actual captured native request and returns after
presentation; it must not wait for a human decision, because the native read
loop must continue receiving events. `respond` accepts only that current
request and one of its advertised decisions. It rechecks current host
authorization and writer ownership, then durably reserves the exact request
and decision before sending. Altered, stale and duplicate decisions are
refused. A send acknowledgement is not resolution: the engine must report the
correlated native resolution. An uncertain decision is never sent again.

Only approve-once, reject and cancel are in this initial port. Unsupported
native review kinds must be refused by the adapter; they are not automatic
approvals. This mechanism does not fabricate Namzu checkpoints or route
channel DTOs into native execution.

`cancel(currentTurnId)` requires the exact admitted turn. A native interrupt
acknowledgement means requested; cancellation waits for its actual terminal
event. A `process-stop` adapter can instead confirm that its owned process and
descendants stopped. `run` owns AbortSignal cancellation after dispatch and
removes its listener on settlement. Completion statuses map to existing turn
reasons: completed → `end_turn`, cancelled → `cancelled`, failed → `error`.

## Reconnect and cleanup

Connection loss does not prove that work stopped. It leaves
`reconciliation-required`, preserves dispatch/review receipts and blocks new
prompts. `reconnect` uses the exact recorded native binding, never resends the
prompt, and requires a complete, matching native history to recover an active
or terminal turn. Incomplete or unavailable history remains blocked. An
unacknowledged dispatch without a trustworthy native turn pointer also remains
blocked for explicit recovery.

A complete history snapshot must establish current active work and pending
native reviews, not only list prior text. An unresolved recorded decision
cannot be reapproved. Restarting a known terminal session may resume its
native session for a newly authored prompt; it does not replay old prompts.

The writer lease is renewed while the live session is owned. Stale writer
ownership prevents subsequent native operations. `close` releases ownership
after confirmed owned process cleanup; a cleanup failure retains its handle
and writer for retry. Old connection callbacks are fenced, and native tool
effects already completed remain recorded rather than being silently undone.
