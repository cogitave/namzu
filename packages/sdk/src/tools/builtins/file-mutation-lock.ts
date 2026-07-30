const mutationTails = new Map<string, Promise<void>>()

/**
 * Serialize read-modify-write filesystem operations by resolved path within
 * one SDK process. Distributed hosts must still assign one writer per file or
 * provide a storage-level compare-and-swap primitive.
 */
export async function withFileMutationLock<T>(
	key: string,
	operation: () => Promise<T>,
): Promise<T> {
	const previous = mutationTails.get(key) ?? Promise.resolve()
	let release = () => {}
	const current = new Promise<void>((resolve) => {
		release = resolve
	})
	const tail = previous.then(() => current)
	mutationTails.set(key, tail)

	await previous
	try {
		return await operation()
	} finally {
		release()
		if (mutationTails.get(key) === tail) mutationTails.delete(key)
	}
}
