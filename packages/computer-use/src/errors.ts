import type { ComputerUseAction, ComputerUseOutcomeUnknown } from '@namzu/sdk'
import type { SpawnError } from './util/spawn.js'

/**
 * A state-changing desktop subprocess started but did not report a clean
 * completion. The action must not be replayed automatically because the
 * desktop may already reflect all or part of it.
 */
export class ComputerUseOutcomeUnknownError extends Error implements ComputerUseOutcomeUnknown {
	readonly code = 'computer_use_outcome_unknown' as const
	readonly outcome = 'unknown' as const
	readonly retrySafety = 'unsafe' as const
	readonly timedOut: boolean
	readonly exitCode: number

	constructor(
		readonly action: ComputerUseAction['type'],
		failure: SpawnError,
	) {
		super(
			`Computer-use action "${action}" did not complete cleanly after it started. It may have changed the desktop; the outcome is unknown. Take fresh screen or cursor state before deciding what to do, and do not automatically retry the action.`,
		)
		this.name = 'ComputerUseOutcomeUnknownError'
		this.timedOut = failure.result.timedOut
		this.exitCode = failure.result.exitCode
	}
}
