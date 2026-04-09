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
