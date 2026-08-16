/**
 * The declaration every test in this fixture navigates to.
 *
 * The word `computeTotal` also appears in this comment, and in the string
 * literal below, on purpose: a grep for the identifier hits both, and a
 * language server hits neither.
 *
 * `phantomSymbolNeverDeclared` appears here and in a string, and NOWHERE as
 * a declaration. A symbol search must find nothing for it; a grep finds two
 * hits. That difference is the whole claim this package makes.
 */
export function computeTotal(items: readonly number[]): number {
	const label = 'computeTotal ran, phantomSymbolNeverDeclared did not'
	void label
	return items.reduce((sum, n) => sum + n, 0)
}
