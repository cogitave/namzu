/**
 * Stop is a request: the reply goes on until the host reports it ended. Between the two the
 * composer says "Stopping…". The request is remembered with the turn it was made for, so it
 * can never carry over to a later reply.
 */

/** Conversation id to the turn a stop was asked for. */
export type StopRequests = Readonly<Record<string, number>>

type Turn = { running: boolean; turn: number }

/** Whether a stop is under way: asked for this very turn, which is still running. */
export function isStopping(requests: StopRequests, id: string, thread: Turn): boolean {
	return thread.running && requests[id] === thread.turn
}

/** Records a stop; a stop on a reply that already ended is nothing to wait for, so nothing is recorded. */
export function requestStop(requests: StopRequests, id: string, thread: Turn): StopRequests {
	if (!thread.running) return requests
	if (requests[id] === thread.turn) return requests
	return { ...requests, [id]: thread.turn }
}

/** Forgets a stop: the reply ended, or the request did not get through. */
export function clearStop(requests: StopRequests, id: string): StopRequests {
	if (!(id in requests)) return requests
	const { [id]: _gone, ...rest } = requests
	return rest
}
