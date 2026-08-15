---
'@namzu/sdk': major
---

A run's audit trail is now durable and effectively mandatory: a `RunStore` that does not implement it will make every run throw.

`RunStore` gains two methods, `appendAuditEvent`/`readAuditEvents` — declared OPTIONAL on the interface (an existing custom `RunStore` implementation still compiles unchanged), but `RunPersistence.recordAudit` refuses to run silently without them, and this release wires `recordAudit` into the terminal path of **every** run: on completion, on failure, on a verification-gate denial, and on a guardrail block. A host with a custom `RunStore` that omits the two new methods will find every run throwing where it used to complete successfully — a change reachable at runtime even though nothing fails to compile, which is why this is major rather than minor.

**If you provide your own `RunStore`** to `RunPersistence`, `query`, or `drainQuery`: implement `appendAuditEvent(event)` and `readAuditEvents()` before upgrading, or every run against that store will now throw at the point it used to settle. The built-in `RunDiskStore` (a new `audit.jsonl`, alongside `transcript.jsonl`) and `InMemoryRunStore` both implement them already and need no host-side change if you use either unmodified.

`types/run/audit.ts` adds `AuditEvent` (who, what, when, outcome, cost — `cost` is non-optional) and `AuditOutcome` (`'success' | 'failure' | 'refused'`). A permission denial (the verification gate) and a guardrail block each now produce a durable `AuditEvent` with `outcome: 'refused'`, where before neither produced any durable record at all. A run's own completion or failure also records a terminal entry, and the new `replayRun` reconstructs a completed run's cost and status from the trail alone — the append-only trail is authoritative; `Run.costInfo`/`Run.status` are a derived summary cache.

An audit write is never level-filtered or sampled, and a write failure fails the operation being recorded — the opposite of a log sink failure, which `createLogger` already swallows and counts. At most one operational log record (`namzu.audit.written`, `info`) is emitted per audit write, carrying a pointer (`namzu.audit.event_id`, `namzu.audit.seq`) and never a copy of the event's own content.
