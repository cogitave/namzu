// The replacement for `configureLogger`'s "one process, one global" model —
// still one process-wide destination (a CLI genuinely owns the whole
// process), but a destination, not only a threshold: `configureLogger` could
// only raise or lower a level against a fixed `process.stderr.write`.
//
// Nothing in `@namzu/sdk` reads the installed sink yet. This function's
// contract — refuse a second, unannounced install — has to be correct and
// tested from the moment it exists, not from the moment a caller (the CLI)
// starts consuming it, so the refusal is exercised directly here.

import type { LevelFilter, LogSink } from './types.js'

let _processSink: { readonly sink: LogSink; readonly level: LevelFilter } | undefined

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
	_processSink = { sink, level }
}
