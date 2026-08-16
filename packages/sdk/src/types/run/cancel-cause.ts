/**
 * Why a run stopped, when it stopped because somebody stopped it.
 *
 * `stopReason: 'cancelled'` says the run was cancelled and nothing more,
 * and the four cases behind it want four different responses. An operator
 * pressing cancel is not a defect. A parent abandoning its children is a
 * fact about the parent, and looking for the child's problem wastes the
 * reader's time. A budget stop is a configuration question. A hook's
 * refusal is a policy one.
 *
 * The gap was not that the information was thrown away — it was never
 * carried. `AbstractAgent.cancel()` aborted with no argument at all, and
 * `AgentManager` aborted a child with the bare string `'canceled'`, which
 * `abortReasonText` deliberately renders as no reason (it would otherwise
 * print "was cancelled: canceled"). So both paths arrived at the run loop
 * indistinguishable.
 */
export type CancelCause = 'user' | 'parent' | 'budget' | 'hook'

/**
 * The abort reason a cancellation carries.
 *
 * An `Error` subclass rather than a bare value, because `AbortController`
 * reasons cross package boundaries and a plain object gives a reader
 * nothing in a stack trace. `name` is checked rather than `instanceof`,
 * the answer this codebase already settled on for provider errors: two
 * copies of a package defeat `instanceof` and nothing announces it.
 */
export class RunCancelled extends Error {
	override readonly name = 'RunCancelled'

	/**
	 * Named `cancelCause`, not `cause`. `Error.cause` already exists and
	 * means "the error this one wrapped", so reusing it would put two
	 * unrelated meanings on one property name and silently change what
	 * anything reading `err.cause` gets.
	 */
	readonly cancelCause: CancelCause

	constructor(cancelCause: CancelCause) {
		super(`run cancelled by ${cancelCause}`)
		this.cancelCause = cancelCause
	}
}

/**
 * The cause an abort reason carries, or `undefined` for one that carries
 * none.
 *
 * `undefined` is a real answer and not a fallback. A cancellation whose
 * origin nobody recorded is not a user cancellation, and substituting
 * `'user'` would put a confident wrong value where an honest absence
 * belongs.
 */
export function cancelCauseOf(reason: unknown): CancelCause | undefined {
	if (reason instanceof Error && reason.name === 'RunCancelled') {
		return (reason as RunCancelled).cancelCause
	}
	return undefined
}
