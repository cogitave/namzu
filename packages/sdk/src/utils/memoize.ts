export function memoizeAsync<T>(
	fn: () => Promise<T>,
): (() => Promise<T>) & { invalidate: () => void } {
	let cached: { value: T } | undefined

	const wrapper = async (): Promise<T> => {
		if (cached) return cached.value
		const value = await fn()
		cached = { value }
		return value
	}

	wrapper.invalidate = () => {
		cached = undefined
	}

	return wrapper
}
