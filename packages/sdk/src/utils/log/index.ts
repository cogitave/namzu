// The LogSink seam. `../logger.ts` keeps `Logger`, `LogContext`,
// `getRootLogger` and `configureLogger` completely unchanged (now
// `@deprecated`) — this directory is the additive replacement.

export type {
	LevelFilter,
	LogRecord,
	LogSink,
	LogSinkCounters,
	Resource,
	Severity,
} from './types.js'
export type { LogAttributes } from './attributes.js'
export { createLogger, NOOP_LOGGER } from './create-logger.js'
export { installProcessSink } from './process-sink.js'
export { jsonLinesSink, NOOP_SINK, prettySink } from './sinks.js'
// A value export, not a type — sits beside the type re-exports above rather
// than folded into that block, because `export type { ... }` cannot carry a
// runtime const. `EVENT_NAME_ATTRIBUTE` is how a host OUTSIDE this package
// (the CLI's boot narrative, NZ-BOOT-05) names an event without duplicating
// the reserved key `createLogger` promotes off of — see the doc comment on
// the constant itself in `./types.js`.
export { EVENT_NAME_ATTRIBUTE, SCOPE_ATTRIBUTE } from './types.js'
