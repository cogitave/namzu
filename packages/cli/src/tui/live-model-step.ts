import type { PrepareStep } from '@namzu/sdk'

/**
 * Let a model picked while a reply is being written take effect on the next
 * request of that same reply.
 *
 * The request already in flight is never touched: the kernel prepares every
 * step from scratch before it asks the model, so the pick is read here, once
 * per request, and a change lands on the first request after it. `live`
 * returns the model the operator last chose for this provider, or `undefined`
 * when they chose none, in which case the turn keeps the model it started with.
 *
 * Only a model the session's own provider serves belongs here; moving to
 * another provider rebuilds the session and waits for the reply to end.
 */
export function createLiveModelStep(live: () => string | undefined): PrepareStep {
	return () => {
		const pick = live()
		return pick ? { model: pick } : undefined
	}
}
