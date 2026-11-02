import type { ComputerUseAction, ComputerUseOutcomeUnknown } from '@namzu/sdk'
import { STOPPED_TEXT } from './foreground/ladder.js'
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

/**
 * The user pressed Escape while the screen was in use. Every computer-use call
 * for the rest of that turn fails with this fixed message, below the model, so
 * it cannot be talked around.
 */
export class ComputerUseStoppedError extends Error {
	readonly code = 'computer_use_stopped' as const

	constructor() {
		super(STOPPED_TEXT)
		this.name = 'ComputerUseStoppedError'
	}
}

/** What the model reads when the computer is locked. Fixed on purpose. */
export const LOCKED_TEXT =
	'The computer is locked (or a system prompt only the user can answer has the screen), so nothing was done or read. Ask the user to unlock it, then continue. Do not try to work around it.'

/**
 * The computer is locked: a read or a capture would show nothing current, and
 * an action would go nowhere. Nothing was sent.
 */
export class ComputerUseLockedError extends Error {
	readonly code = 'computer_locked' as const

	constructor() {
		super(LOCKED_TEXT)
		this.name = 'ComputerUseLockedError'
	}
}
