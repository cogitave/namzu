/** Enter commits a picker row; arrows only move focus, and Space commits through the native click. */
export function commitsOnKey(key: string): boolean {
	return key === 'Enter'
}

/**
 * The row a project picker may commit, or undefined for an id that is not in the list or for a
 * project whose folder is gone (it is listed so the person sees why it is not offered).
 */
export function committableProject<T extends { id: string; missing?: boolean }>(
	choices: readonly T[],
	id: string,
): T | undefined {
	const found = choices.find((item) => item.id === id)
	return found && !found.missing ? found : undefined
}
