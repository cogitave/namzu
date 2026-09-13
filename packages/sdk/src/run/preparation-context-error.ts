import { toErrorMessage } from '../utils/error.js'

/**
 * Internal bridge for SDK preparation failures with a safe availability note.
 * The cause remains diagnostic-only. Ordinary thrown errors never become context.
 */
export class PreparationContextError extends Error {
	constructor(
		cause: unknown,
		readonly context: string,
	) {
		super(toErrorMessage(cause), { cause })
		this.name = 'PreparationContextError'
	}
}
