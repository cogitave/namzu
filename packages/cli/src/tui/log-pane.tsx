/**
 * The TUI's log sink (LOG-05).
 *
 * Ink owns the terminal for the life of `launchTui()`: it repaints the
 * screen from its own virtual buffer, and any other write to stdout/stderr
 * while it holds the terminal corrupts the frame mid-repaint. The previous
 * fix for that forced the SDK logger's level to `silent` via
 * `configureLogger`, which threw every diagnostic away rather than
 * choosing where it belonged. The correct choice is a sink that does not
 * write: a bounded ring buffer, drained to stderr only once Ink has
 * released the terminal — on a clean exit, or on a crash Ink itself did
 * not catch.
 *
 * The ring buffer is implemented HERE rather than imported from
 * `@namzu/sdk`: LOG-04's confirmed export list (LogRecord, LogSink,
 * LogSinkCounters, createLogger, installProcessSink, jsonLinesSink,
 * prettySink, NOOP_SINK, NOOP_LOGGER, Severity, LevelFilter, Resource)
 * does not include a `ringBufferSink`, and this is the only place in the
 * tree that needs one.
 *
 * REVIEWER NOTE (see risks): the ratified design's §8 Increment-1 table
 * DOES list `ringBufferSink` as part of what LOG-04 ships, and §6.1's own
 * row for this exact file says `ringBufferSink(512)`. That is a real
 * disagreement between the design's migration table and LOG-04's terser
 * acceptance-criteria export list, not something this file can resolve —
 * building it locally is the conservative choice given the acceptance
 * list is the nearer-term authoritative contract, but if/when LOG-04
 * lands `ringBufferSink`, this local copy should be deleted and this file
 * should import the SDK's instead, per `read-the-neighbour`.
 */

import { NOOP_LOGGER, jsonLinesSink, prettySink } from '@namzu/sdk'
import type { LogRecord, LogSink } from '@namzu/sdk'

import { EXIT_INTERNAL_ERROR } from '../exit-codes.js'
import { contextLogging, installCliLogging } from '../logging.js'
import type { ResolvedLogging } from '../logging.js'

/** `ringBufferSink(512)` in the ratified design (§6.1) — enough for a full
 *  boot narrative plus a run's worth of tool chatter without holding an
 *  unbounded amount of a long TUI session's history in memory. */
const RING_CAPACITY = 512

function createRingBufferSink(capacity: number): LogSink & { drain(): readonly LogRecord[] } {
	const buffer: LogRecord[] = []
	return {
		emit(record: LogRecord): void {
			buffer.push(record)
			// Oldest-first eviction — a RING, not a growing transcript. The
			// records worth reading after a crash are the most recent ones.
			if (buffer.length > capacity) buffer.shift()
		},
		drain(): readonly LogRecord[] {
			return buffer.splice(0, buffer.length)
		},
	}
}

/**
 * Installs the ring buffer as the process sink for the life of the TUI and
 * registers the two flush paths Ink cannot own itself: a clean exit,
 * driven by the function this returns (`launchTui`'s `finally`), and a
 * crash — an uncaught exception or an unhandled rejection reaching the top
 * of the process, neither of which `waitUntilExit()` ever resolves for.
 * Both listeners are `.once`, removed the moment either fires: a sink that
 * itself throws while flushing must not re-enter the same handler, and a
 * process that launches the TUI more than once in its lifetime (this
 * package's own tests) must not accumulate one pair per launch.
 *
 * `logging` is optional — see `TuiContext.logging` — and falls back
 * through `contextLogging` to the same resolution an invocation with no
 * flags and no env override would have gotten.
 */
export function installTuiLogSink(logging?: ResolvedLogging): () => void {
	const resolved = contextLogging({ logging })
	const ring = createRingBufferSink(RING_CAPACITY)
	installCliLogging(ring, resolved.level)

	let flushed = false
	const flush = (): void => {
		// Idempotent: a crash's default handling ends the process, which also
		// emits 'exit' — both fire for the same crash, and a second pass must
		// not print an empty batch's worth of nothing a second time.
		if (flushed) return
		flushed = true
		process.removeListener('uncaughtException', onFatal)
		process.removeListener('unhandledRejection', onFatal)
		process.removeListener('exit', flush)
		const out: LogSink =
			resolved.format === 'json' ? jsonLinesSink(process.stderr) : prettySink(process.stderr)
		for (const record of ring.drain()) out.emit(record)
	}

	// Registering a listener for either event turns OFF Node's own default
	// handling (print the error, exit 1) — both replicated explicitly below,
	// after the buffer is flushed, so a crash mid-session does not also drop
	// the last thing an operator would want to read about it. Ink has
	// already released the terminal by the time either handler runs (the
	// render loop stopped pumping before the process got here), so a plain
	// write is safe — this file IS the TUI's sink implementation, the one
	// place allowed to touch the stream directly on the way out of a
	// process that is already ending.
	const onFatal = (err: unknown): void => {
		flush()
		process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
		process.exit(EXIT_INTERNAL_ERROR)
	}
	process.once('uncaughtException', onFatal)
	process.once('unhandledRejection', onFatal)
	process.once('exit', flush)

	return flush
}
