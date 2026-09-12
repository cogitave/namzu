import { subscribeToAbort } from './abort.js'

/**
 * Stop waiting without releasing any lock owned by the operation. Its promise
 * stays observed until settlement; cancellation cannot reorder queued work.
 * The operation must also check the signal before starting work and pass it
 * into cooperative I/O. This race cannot stop an uncooperative backend.
 */
export async function awaitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return operation
	if (signal.aborted) {
		void operation.catch(() => {})
		signal.throwIfAborted()
	}
	let dispose = () => {}
	const cancelled = new Promise<never>((_resolve, reject) => {
		dispose = subscribeToAbort(signal, () => reject(signal.reason))
	})
	try {
		const result = await Promise.race([operation, cancelled])
		signal.throwIfAborted()
		return result
	} finally {
		dispose()
	}
}
