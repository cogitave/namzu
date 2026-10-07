/** Enter commits a picker row; arrows only move focus, and Space commits through the native click. */
export function commitsOnKey(key: string): boolean {
	return key === 'Enter'
}

/** The row a project picker may commit, or undefined for an id that is not in the list. */
export function committableProject<T extends { id: string }>(
	choices: readonly T[],
	id: string,
): T | undefined {
	return choices.find((item) => item.id === id)
}
