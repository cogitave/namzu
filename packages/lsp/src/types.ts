/**
 * Code navigation an agent can trust, which grep is not.
 *
 * The whole code-navigation surface this kernel had was `grep` (regex over
 * file text) and `glob` (filename patterns). An agent asked to find every
 * call site of a function got every textual occurrence — the comment
 * mentioning it, the string literal naming it, the unrelated same-named
 * symbol in another scope — and MISSED the call sites that arrive through a
 * re-export or a destructure. That last half is the one a rename has to get
 * right, and it is exactly the half a regex cannot see.
 *
 * Two operations, deliberately. A provider interface with twenty methods
 * and one implementation is a guess at what a consumer needs; these two are
 * what the failure above actually requires, and the shape is the same one
 * `Sandbox` uses — a host constructs one and hands it over, with no
 * `registerProvider()`-with-discovery indirection in between.
 */

/**
 * Re-exported from `@namzu/sdk`, never re-declared.
 *
 * The dependency direction is `sdk ← lsp`, so the kernel owns the shape a
 * tool programs against and this package implements it. A second
 * declaration here would compile — the shapes are structural — and would be
 * a copy that can drift, with the drifted one deciding whether the `lsp`
 * builtin accepts this provider at all.
 */
export type {
	CodeNavigationProvider,
	CodeNavigationResult,
	SourceLocation,
} from '@namzu/sdk'
