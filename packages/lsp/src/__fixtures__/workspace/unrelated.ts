/**
 * A DIFFERENT symbol with the same name, in another scope.
 *
 * A regex over the workspace counts this as a reference to `a.ts`'s
 * function. A resolver does not, and that difference is what the
 * integration test asserts.
 */
function computeTotal(): number {
	return -1
}

export const unrelatedTotal = computeTotal()
