// The pipeline: builds a record from a call, runs it through redaction and
// the size caps, then dispatches to the configured sink — catching whatever
// that sink does, because a host sink is arbitrary code the kernel does not
// control.
//
// `createLogger` returns a plain `Logger` with one extra, non-Logger
// property (`counters`) riding along on the same object. That is a
// deliberate choice over a `{ logger, counters }` pair: the returned value
// still satisfies `logger?: Logger` at every existing call site with no
// unwrapping, while a caller that wants to observe the pipeline — a test,
// `namzu doctor` later — reads `.counters` off the same reference.

import type { LogContext, Logger } from '../logger.js'
import { capAttributeCount, capTotalSize, truncateValues } from './caps.js'
import { redactRecord } from './redact.js'
import { NOOP_SINK } from './sinks.js'
import type {
	LevelFilter,
	LogRecord,
	LogSinkCounters,
	LoggerOptions,
	MutableLogSinkCounters,
	Severity,
} from './types.js'

const SEVERITY_RANK: Record<Severity, number> = { debug: 0, info: 1, warn: 2, error: 3 }
const LEVEL_RANK: Record<LevelFilter, number> = { ...SEVERITY_RANK, silent: 4 }
const SEVERITY_NUMBER: Record<Severity, 5 | 9 | 13 | 17> = {
	debug: 5,
	info: 9,
	warn: 13,
	error: 17,
}

export type CreatedLogger = Logger & { readonly counters: LogSinkCounters }

export function createLogger(options: LoggerOptions): CreatedLogger {
	const counters: MutableLogSinkCounters = {
		dropped: 0,
		redacted: 0,
		attributesDropped: 0,
		valuesTruncated: 0,
		recordsTruncated: 0,
	}
	return build(options, counters, {})
}

function build(
	options: LoggerOptions,
	counters: MutableLogSinkCounters,
	bound: Readonly<Record<string, unknown>>,
): CreatedLogger {
	function emit(severityText: Severity, body: string, data?: LogContext): void {
		// Read per record, off the shared mutable holder — never resolved once
		// and captured in this closure. Today's `Logger.child()` bakes its level
		// in exactly that way, which is why three module-scope loggers in the
		// skills/plugin loaders are frozen at `info` forever and unreachable by
		// any later `configureLogger` call.
		if (SEVERITY_RANK[severityText] < LEVEL_RANK[options.level.current]) return

		const now = Date.now()
		let record: LogRecord = {
			timestamp: now,
			observedTimestamp: now,
			severityNumber: SEVERITY_NUMBER[severityText],
			severityText,
			body,
			scope: { name: options.scope },
			resource: options.resource,
			attributes: { ...bound, ...data },
		}

		// Order matters: redact BEFORE capping. Truncating a value first could
		// slice a secret in half and ship the surviving fragment; the
		// `[REDACTED:label]` placeholder redaction leaves behind is short and
		// never needs truncating itself.
		record = redactRecord(record, counters)
		record = capAttributeCount(record, counters)
		record = truncateValues(record, counters)
		record = capTotalSize(record, counters)

		dispatch(record)
	}

	function dispatch(record: LogRecord): void {
		if (options.sink === NOOP_SINK) {
			counters.dropped++
			return
		}
		try {
			options.sink.emit(record)
		} catch {
			// A host sink is arbitrary code the kernel does not control. The old
			// direct `process.stderr.write` implementation could never throw into
			// an in-flight run; a naive seam here would introduce that failure
			// mode for the first time — a broken sink aborting, say, a
			// tool-completion path. Never rethrown, never logged through the same
			// sink that just failed — counted instead, so a doctor check can
			// surface a sink that is silently eating every record.
			counters.dropped++
		}
	}

	return {
		debug: (message, data) => emit('debug', message, data),
		info: (message, data) => emit('info', message, data),
		warn: (message, data) => emit('warn', message, data),
		error: (message, data) => emit('error', message, data),
		child: (context) => build(options, counters, { ...bound, ...context }),
		counters,
	}
}

/**
 * A logger that discards everything, countably. Every call is accepted (the
 * level is `debug`, the widest threshold), and every accepted call is routed
 * to `NOOP_SINK` and counted as dropped — a host holding `NOOP_LOGGER` can
 * still tell "N calls happened and were discarded" from "N calls never
 * happened", which a logger that filtered everything out at `silent` could
 * not: a filtered call never reaches dispatch and is never counted at all.
 */
export const NOOP_LOGGER: CreatedLogger = createLogger({
	sink: NOOP_SINK,
	level: { current: 'debug' },
	resource: { 'service.name': '@namzu/sdk' },
	scope: 'namzu.noop',
})
