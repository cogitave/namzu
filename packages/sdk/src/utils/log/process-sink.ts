// One process-wide DESTINATION, and nothing else process-wide.
//
// This replaced a "one process, one global logger" model that could only
// raise or lower a level against a fixed `process.stderr.write` — a
// threshold, never a destination. A CLI genuinely does own its whole process,
// so a single installed sink is the right shape for that half.
//
// What it deliberately is NOT is a logger. Installing a sink does not reroute
// anything on its own: it sets where records go and owns the counter set, and
// the host builds a logger over it (`createLogger`, passing
// `getProcessSinkCounters()`) and hands that down. LOG-20 removed the global
// accessor that used to bridge the two automatically, because "automatically"
// meant a library nobody handed a logger wrote to the host's stderr.

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
 * Internal in spirit, exported in fact: a mere reader wants
 * {@link getProcessSink}'s readonly view. A HOST needs this one, because it
 * is what makes the totals describe the process rather than one logger — it
 * hands the same object to every logger it builds, so `getLogCounters()` and
 * `namzu doctor`'s `logging.pipeline` check see one set of numbers. A global
 * accessor used to do that on the host's behalf; with it gone, the host does
 * it, which is why this is reachable from `@namzu/sdk` at all.
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
