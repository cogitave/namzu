/** A script that cannot run: bad `meta`, too large, bad `args`. Nothing started. */
export class WorkflowScriptError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'WorkflowScriptError'
	}
}
