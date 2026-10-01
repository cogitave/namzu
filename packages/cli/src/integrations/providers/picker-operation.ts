const PICKER_PROVIDER_DEADLINE_MS = 3_000

export class PickerProviderTimeoutError extends Error {
	constructor() {
		super(`The provider did not answer within ${PICKER_PROVIDER_DEADLINE_MS}ms.`)
		this.name = 'PickerProviderTimeoutError'
	}
}

/** Bound a picker side-call even when a third-party provider ignores abort. */
export async function runPickerProviderOperation<T>(
	signal: AbortSignal | undefined,
	operation: (operationSignal: AbortSignal) => Promise<T>,
): Promise<T> {
	signal?.throwIfAborted()
	const controller = new AbortController()
	const timeoutCause = new PickerProviderTimeoutError()
	let rejectBoundary: (cause: unknown) => void = () => {}
	const boundary = new Promise<never>((_resolve, reject) => {
		rejectBoundary = reject
	})
	const onCallerAbort = () => {
		controller.abort(signal?.reason)
		rejectBoundary(signal?.reason)
	}
	signal?.addEventListener('abort', onCallerAbort, { once: true })
	const timer = setTimeout(() => {
		controller.abort(timeoutCause)
		rejectBoundary(timeoutCause)
	}, PICKER_PROVIDER_DEADLINE_MS)

	try {
		return await Promise.race([operation(controller.signal), boundary])
	} catch (error) {
		// Cooperative transports may replace the owner cause with AbortError.
		if (signal?.aborted) throw signal.reason
		if (controller.signal.aborted && controller.signal.reason === timeoutCause) throw timeoutCause
		throw error
	} finally {
		clearTimeout(timer)
		signal?.removeEventListener('abort', onCallerAbort)
	}
}
