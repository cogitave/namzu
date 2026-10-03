/** In-process cancellation from an explicit owned transport close, never a wire failure. */
export class ExpectedRuntimeCloseError extends Error {
	override readonly name = 'ExpectedRuntimeCloseError'
	constructor() {
		super('The Namzu connection was closed.')
	}
}
