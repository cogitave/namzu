import { NOOP_LOGGER } from './log/create-logger.js'
import { getProcessSink } from './log/process-sink.js'
import type { LogSinkCounters } from './log/types.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

export type LogContext = Record<string, unknown>

export interface Logger {
	debug(message: string, data?: LogContext): void
	info(message: string, data?: LogContext): void
	warn(message: string, data?: LogContext): void
	error(message: string, data?: LogContext): void
	child(context: LogContext): Logger
}

/**
 * A logger that discards, when nobody supplied one.
 *
 * The fallback used to be a process-wide global, so a construction with no
 * logger silently wrote to stderr — from a library, on a stream the host may
 * be using for its own protocol. LOG-20 flipped it: a component given no
 * logger produces nothing, and the drop is counted where `getLogCounters()`
 * can read it.
 *
 * The seam stays rather than being inlined at each call site, so every
 * constructor in the package expresses "logger optional" the same way and one
 * line decides what optional means.
 */
export function resolveLogger(logger: Logger | undefined): Logger {
	return logger ?? NOOP_LOGGER
}

/**
 * What the record pipeline did to the records it was given, or `undefined`
 * when no host has claimed the process's log destination.
 *
 * `undefined` is the honest answer for that case, not a zeroed set. With no
 * sink installed there is no pipeline, and therefore no redaction pass, no
 * size caps and nothing to count -- reporting five zeros would read as
 * "nothing was dropped, nothing was redacted", a stronger claim than "this
 * was never measured" and the one a reader most wants to trust.
 * `namzu doctor`'s `logging.pipeline` check turns the absence into its own
 * row rather than into a clean bill of health.
 */
export function getLogCounters(): LogSinkCounters | undefined {
	return getProcessSink()?.counters
}
