// The replacement for `configureLogger`'s "one process, one global" model —
// still one process-wide destination (a CLI genuinely owns the whole
// process), but a destination, not only a threshold: `configureLogger` could
// only raise or lower a level against a fixed `process.stderr.write`.
//
// `getRootLogger` reads this: when a sink is installed, the deprecated
// accessor routes through it instead of writing straight to stderr. That
// bridge is what makes the seam reachable without rewriting the ~39 existing
// `getRootLogger()` call sites in one commit — they keep the old shape and
// gain the new destination.

import { newCounters } from './create-logger.js'
import type { LevelFilter, LogSink, LogSinkCounters, MutableLogSinkCounters } from './types.js'

interface InstalledSink {
	readonly sink: LogSink
	readonly level: LevelFilter
	readonly counters: MutableLogSinkCounters
}

let _processSink: InstalledSink | undefined

export function installProcessSink(
	sink: LogSink,
	level: LevelFilter,
	opts: { readonly replace?: boolean } = {},
): void {
	if (_processSink !== undefined && !opts.replace) {
		// `refuse-do-not-degrade`: two callers each believing they own the
		// process's log destination is a defect, not something to merge
		// silently — the second install wins with neither party told, and
		// whichever caller configured the first one loses its destination
		// without an error anywhere in the tree.
		throw new Error(
			'installProcessSink was already called for this process. Two callers each believing ' +
				"they own the process's log destination is a defect, not something to merge silently " +
				'— pass { replace: true } if this call is a deliberate replacement of an earlier one.',
		)
	}
	// One counter set per installed destination, so every logger that
	// routes through it adds to the same totals. A `replace: true` install
	// starts fresh: the counts describe the destination that is live, and
	// carrying the old one's forward would attribute its drops to a sink
	// that never saw those records.
	_processSink = { sink, level, counters: newCounters() }
}

/** The installed destination, or `undefined` when nobody claimed the process. */
export function getProcessSink():
	| { readonly sink: LogSink; readonly level: LevelFilter; readonly counters: LogSinkCounters }
	| undefined {
	return _processSink
}

/**
 * The mutable counter set the installed destination writes through.
 *
 * Internal: a reader wants {@link getProcessSink}'s readonly view. This
 * exists so `getRootLogger`'s bridge can hand the SAME object to every
 * logger it builds, which is what makes the totals process-wide rather
 * than per-call.
 */
export function getProcessSinkCounters(): MutableLogSinkCounters | undefined {
	return _processSink?.counters
}

/**
 * Test-only: forget the installed sink.
 *
 * Production must never call this — the refusal above is the whole contract,
 * and a reset that production could reach would let a second caller take the
 * destination by clearing the first one rather than by saying `replace`.
 */
export function __resetProcessSinkForTests(): void {
	_processSink = undefined
}
