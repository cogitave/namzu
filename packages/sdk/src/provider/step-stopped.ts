/**
 * The reason a step is stopped on purpose, by the loop that is reading it.
 *
 * A step that has spent its whole reasoning allowance is cut short: the loop
 * stops reading the stream and aborts the request it opened. That abort is the
 * loop's own decision, not a caller's stop and not a transport failure, so it
 * carries this class as its reason. A provider wrapper that sees an aborted
 * request can tell the two apart with {@link isStepStopped} and must not retry
 * it, fail over from it, or report it as an error.
 */
export class StepStopped extends Error {
	override readonly name = 'StepStopped'

	constructor() {
		super('the step was stopped by the loop that was reading it')
	}
}

/** Whether an abort reason, or an error that carries one, is a deliberate step stop. */
export function isStepStopped(value: unknown): value is StepStopped {
	return value instanceof StepStopped
}

/** Whether a request signal was aborted by a deliberate step stop. */
export function stepWasStopped(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true && isStepStopped(signal.reason)
}
