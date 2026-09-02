---
title: Session export — what leaves the machine, and the sentence that says so
description: How a session's run events are exported, why the redaction chain drops rather than degrades when a redactor refuses or throws, and how the boot disclosure is derived from the event filter so it cannot disagree with what is actually sent.
type: Guide
status: stable
resource: packages/telemetry/src/session-export.ts
tags: [telemetry, observability, privacy, redaction]
generated: { by: human:bahadirarda, at: 2026-08-16T00:00:00Z }
---

# Session export

`@namzu/telemetry`'s spans and metrics describe the agent's own execution —
`namzu.agent.run`, `namzu.tool.execute`, the chat spans. That is operational
tracing, and it is deliberately not a mirror of the conversation.

Session export is the other thing: the run's own events, including what the
model said and what tools returned, written somewhere an operator can read
later. It is off unless configured, it is disclosed at boot when it is on,
and everything about its design follows from one property — **a redaction
stage that fails open exports exactly the record somebody installed a
redactor to stop.**

## Turning it on

```json
{
  "telemetry": {
    "sessionExport": {
      "destination": ".namzu/session.jsonl",
      "eventTypes": ["text_delta", "tool_completed", "run_completed"],
      "redactors": ["secrets"]
    }
  }
}
```

`destination` is a JSONL file path, one record per line. It is a file rather
than a URL, and that is a limit rather than an oversight: a network
destination needs retry, backpressure and a credential, and a half-built one
would be an export that silently drops. A host that needs a collector builds
a `SessionExportSink` and attaches the listener itself — that seam is the
package's public surface.

`eventTypes` is optional; absent means every run event. `redactors` is
optional too, and **omitting it installs the shipped `secrets` redactor**.
Turning redaction off takes an explicit `"redactors": []`, because reaching
"no redaction" by forgetting a key is the outcome this seam exists to
prevent.

## What the chain guarantees

A redactor is `(record) => record | null`, applied in declared order.

- **Returning `null` drops the record and stops the chain.** Later redactors
  do not run — asking them to transform a record that is not going anywhere
  invites one of them to observe a call nobody made a decision about.
- **A redactor that THROWS also drops the record.** The un-redacted record is
  never emitted as a fallback. The exception does not escape either: the
  listener runs inside the run's own event loop, and a broken exporter must
  not be able to end a run.
- **`emit` is fire-and-forget.** A sink that batches, retries or dials a
  network costs the run nothing. A sink that throws is caught and counted
  separately from a refusal, because "the redactor refused" and "the
  destination is down" send an operator to different places.

The listener carries four counters — `exported`, `dropped`, `failed`,
`filtered` — for the same reason: a redactor refusing is silent by design,
and "nothing was exported" is otherwise indistinguishable from "everything
was dropped".

## The disclosure

`describeSessionExport(config)` returns one sentence naming the destination,
the exported event types, the installed redactor count, and whether
conversation text is included. It is printed at boot under
`namzu.telemetry.status` and again as a `namzu doctor` row, because the
operator who configured it and the person whose conversation leaves the
machine are frequently not the same person.

**The "conversation text is included" half is DERIVED from `eventTypes`, not
declared beside them.** A separate `includeMessageText` flag could disagree
with the filter, and the disclosure would then have to pick one of them to
believe. `CONTENT_BEARING_EVENT_TYPES` enumerates the event types that carry
model- or user-authored text, read off the fields each member of `RunEvent`
declares, and the sentence is computed against it.

It reads differently when export is off, deliberately. A disclosure that read
the same in both states would satisfy any test asserting "the disclosure is
shown" while telling a user nothing about which situation they are in.

## What this is NOT

It is not a boundary the OS enforces, and not a guarantee that a redactor
caught everything. The shipped redactor matches `LOG_SECRET_PATTERNS` — the
wider of the SDK's two credential tables, chosen because a false positive
here redacts one word out of an exported record, where a false positive in
model output would rewrite the answer a caller asked for. A credential in a
shape the table does not know reaches the sink.

The seam makes redaction possible and states its own reach. It does not make
leakage inexpressible, and a page that claimed otherwise would be the kind of
sentence this documentation standard exists to keep out.

## Refusing rather than degrading

`@namzu/telemetry` is an optional package. Everywhere else in the CLI its
absence degrades a feature and says so. **Not here.** An operator who wrote
`sessionExport` into a config asked for the session to be recorded;
continuing without it means the run happens and the record they were counting
on does not exist — a failure they discover only when they go looking for a
session that was never written. The CLI refuses to start the run, and
`namzu doctor` reports the same state as a `fail` with both ways out named.

A malformed `sessionExport` block is dropped whole rather than field by
field, for the same reason: a mistyped `redactors` read leniently would leave
export ON with redaction silently OFF. Dropping it makes the boot line read
"off", which is visible.
