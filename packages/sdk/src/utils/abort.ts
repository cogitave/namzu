import { toErrorMessage } from './error.js'

/**
 * The words a caller attached to a stop, or nothing when there were none.
 *
 * A cancellation and a deadline arrive by the same mechanism and mean opposite
 * things to whoever reads the result. "Was cancelled" tells a model that
 * something outside it decided, and nothing about what — so a tool result
 * could not distinguish an operator pressing stop from a budget running out
 * from a parent abandoning a child, and every one of those wants a different
 * next move.
 *
 * Two kinds of reason are deliberately reported as no reason:
 *
 * - `AbortError` and `TimeoutError`. `abort()` with no argument fills `reason`
 *   with a DOMException named `AbortError`, so it is not a message anybody
 *   wrote; it is the platform's word for "someone stopped and said nothing".
 *   Rendering it would turn today's honest silence into a fake explanation.
 * - Anything that is not an `Error`. The agent manager aborts a child with the
 *   bare string `'canceled'`, which would otherwise render as "was cancelled:
 *   canceled" — noise wearing the shape of information.
 *
 * Name-checked rather than checked by class, because a reason can cross a
 * package boundary where `instanceof` stops holding across duplicate copies.
 * That is the same answer this codebase already settled on for provider
 * errors.
 */
export function abortReasonText(reason: unknown): string | undefined {
	if (!(reason instanceof Error)) return undefined
	if (reason.name === 'AbortError' || reason.name === 'TimeoutError') return undefined
	const text = toErrorMessage(reason).trim()
	return text.length > 0 ? text : undefined
}

export function createChildAbortController(parent: AbortController): AbortController {
	const child = new AbortController()

	if (parent.signal.aborted) {
		child.abort(parent.signal.reason)
		return child
	}

	const weakChild = new WeakRef(child)

	const onParentAbort = (): void => {
		const ref = weakChild.deref()
		if (ref && !ref.signal.aborted) {
			ref.abort(parent.signal.reason)
		}
	}

	parent.signal.addEventListener('abort', onParentAbort, { once: true })

	child.signal.addEventListener(
		'abort',
		() => {
			parent.signal.removeEventListener('abort', onParentAbort)
		},
		{ once: true },
	)

	return child
}
