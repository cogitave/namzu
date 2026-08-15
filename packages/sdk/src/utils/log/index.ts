// The LogSink seam. `../logger.ts` keeps `Logger`, `LogContext`,
// `getRootLogger` and `configureLogger` completely unchanged (now
// `@deprecated`) — this directory is the additive replacement described in
// docs/conventions and the observability docs page once those land.

export type {
	LevelFilter,
	LogRecord,
	LogSink,
	LogSinkCounters,
	Resource,
	Severity,
} from './types.js'
export { createLogger, NOOP_LOGGER } from './create-logger.js'
export { installProcessSink } from './process-sink.js'
export { jsonLinesSink, NOOP_SINK, prettySink } from './sinks.js'
