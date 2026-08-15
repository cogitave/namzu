---
'@namzu/sdk': minor
---

Add the LogSink seam: `createLogger`, pluggable sinks, and a record-boundary redaction/size pipeline

`packages/sdk/src/utils/logger.ts` wrote directly to `process.stderr` with no way to redirect, replace, or intercept it — the CLI's only lever was `configureLogger({ level: 'silent' })`, which is why every entry point silences the logger outright instead of pointing it somewhere useful.

This adds the seam additively. `Logger`, `getRootLogger` and `configureLogger` keep their exact signatures and behaviour — every existing test passes unmodified — and are now marked `@deprecated`, naming their replacements:

- `LogRecord` — the emitted record shape (a subset of the OTel Logs Data Model: timestamp, severity, body, scope, resource, attributes). No `traceId`/`spanId`/`eventName` yet — those ship with their own emitters in later work, not as unwritten fields today.
- `LogSink` — `{ emit(record) }`, the seam a host implements to receive records.
- `createLogger(options)` — builds a `Logger` whose destination and level come from the caller's options, not a module-global. The level is read per record off `options.level.current`, never captured at construction. A sink whose `emit` throws is caught and counted, never rethrown into the caller — the old direct `stderr.write` could never throw into kernel control flow, and a naive seam would have introduced that failure mode for the first time.
- A record-boundary pipeline every sink receives the same output of: secret redaction, an 8 KiB per-value truncation cap, a 64-attribute count cap, and a 16 KiB total-record cap — each counted, and enforced once in `createLogger` rather than duplicated per sink. A custom sink cannot bypass any of it.
- `jsonLinesSink(stream)` — NDJSON, additionally escaping U+2028/U+2029 beyond what `JSON.stringify` handles.
- `prettySink(stream)` — human-readable lines, with every C0 control byte (ESC included) rendered as inert `\xNN` text in every field, not only the body.
- `NOOP_SINK` / `NOOP_LOGGER` — every accepted call counts as dropped, so a host can tell "nothing configured" apart from "configured and silently eating records".
- `installProcessSink(sink, level, opts?)` — the CLI's future replacement for `configureLogger`; refuses a second call unless `{ replace: true }` is passed.
- `Severity`, `LevelFilter`, `Resource`, `LogSinkCounters` — the supporting types.

No behaviour change to anything already shipping: the seam is inert until a host calls `installProcessSink` or `createLogger`, which nothing in this package does yet.
