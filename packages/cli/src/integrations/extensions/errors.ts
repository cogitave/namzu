/** A refusal the person can read: a stable code, the check that failed, and what to do about it. */
export class ExtensionError extends Error {
	override readonly name = 'ExtensionError'
	constructor(
		readonly code: string,
		readonly check: string,
		message: string,
	) {
		super(message)
	}
}
