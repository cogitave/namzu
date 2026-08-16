---
'@namzu/telemetry': minor
'@namzu/cli': minor
---

`@namzu/telemetry` gains a session export seam: a run's own events, through an ordered redaction chain, to a sink you supply — with one sentence a host can show a user before any of it leaves the machine.

Spans and metrics describe the agent's execution. They are deliberately not a mirror of the conversation, so an operator who wanted to hand a session to support had no seam at all: they would instrument the store by hand, with no redaction extension point and nothing to disclose.

New exports: `createSessionExportListener`, `describeSessionExport`, `secretRedactor`, `CONTENT_BEARING_EVENT_TYPES`, and the `SessionExportSink` / `SessionExportRedactor` / `SessionExportRecord` / `SessionExportConfig` / `SessionExportListener` types. The listener is assignable to the SDK's `RunEventListener`, so it attaches to `query({ onEvent })` with no new hook. The record wraps `RunEvent` verbatim rather than flattening it into an export-shaped copy — a second definition of every event in the kernel is one that can drift, and the drifted one would be what an operator reads during an incident.

**A redactor may refuse, and a refusal never falls open.** Returning `null` drops the record and stops the chain; a redactor that THROWS also drops it, and the un-redacted record is never emitted as a fallback. The exception does not escape into the run either. `emit` is fire-and-forget, so a slow destination cannot stall a turn, and a throwing sink is counted apart from a refusing redactor — "the redactor refused" and "the collector is down" send an operator to different places.

**The disclosure cannot disagree with the filter.** `describeSessionExport` names the destination, the event types, the redactor count, and whether conversation text is included — and that last one is derived from `eventTypes` rather than declared beside them. It returns a distinct sentence when export is off, because one that read the same in both states would tell a user nothing.

In `@namzu/cli`: a `telemetry.sessionExport` config block (`destination`, `eventTypes`, `redactors`), the disclosure emitted at boot under `namzu.telemetry.status`, and a `telemetry.session-export` doctor row that names the destination and the redactor count.

Two refusals rather than degradations. If `sessionExport` is configured and `@namzu/telemetry` is not installed, the run does not start — continuing would mean the session happens and the record the operator was counting on does not exist. And a malformed `sessionExport` block is dropped whole rather than field by field, because a mistyped `redactors` read leniently would leave export ON with redaction silently OFF; dropping it makes the boot line read "off", which is visible.

Omitting `redactors` installs the shipped `secrets` redactor. Turning redaction off takes an explicit `[]`.
