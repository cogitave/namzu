/**
 * Bound a host-supplied RAG promise to operation cancellation.
 *
 * The signal is also passed to cooperative providers. This race is the
 * kernel-owned half of the contract: a custom store that ignores its signal
 * may continue its own work, but it cannot keep the public operation pending
 * or make a late result advance the caller's pipeline.
 */
export async function awaitRAGOperation<T>(
	operation: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (!signal) return operation
	signal.throwIfAborted()

	let rejectAbort: ((reason?: unknown) => void) | undefined
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject
	})
	const onAbort = (): void => rejectAbort?.(signal.reason)
	signal.addEventListener('abort', onAbort, { once: true })

	try {
		return await Promise.race([operation, aborted])
	} finally {
		signal.removeEventListener('abort', onAbort)
	}
}
