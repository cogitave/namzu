/**
 * The declaration every test in this fixture navigates to.
 *
 * The word `computeTotal` also appears in this comment, and in the string
 * literal below, on purpose: a grep for the identifier hits both, and a
 * language server hits neither.
 */
export function computeTotal(items: readonly number[]): number {
	const label = 'computeTotal ran'
	void label
	return items.reduce((sum, n) => sum + n, 0)
}
