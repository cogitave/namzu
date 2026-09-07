/** A deliberately public HTTP error; its message is safe to return to the caller. */
export class AGUIRequestError extends Error {
	constructor(
		message: string,
		readonly status = 422,
		readonly code = 'INVALID_REQUEST',
	) {
		super(message)
		this.name = 'AGUIRequestError'
		if (!Number.isInteger(status) || status < 400 || status > 599)
			throw new RangeError('AG-UI request error status must be between 400 and 599')
	}
}
