import { type ReactNode, isValidElement } from 'react'

function valuesEqual(a: unknown, b: unknown, depth: number): boolean {
	if (Object.is(a, b)) return true
	// A handler is made fresh on every render and does the same thing; what it reads shows in the data.
	if (typeof a === 'function' && typeof b === 'function') return true
	if (isValidElement(a) || isValidElement(b)) return renderedEqual(a as ReactNode, b as ReactNode)
	if (Array.isArray(a) && Array.isArray(b))
		return a.length === b.length && a.every((value, index) => valuesEqual(value, b[index], depth))
	if (depth <= 0 || !a || !b || typeof a !== 'object' || typeof b !== 'object') return false
	const left = a as Record<string, unknown>
	const right = b as Record<string, unknown>
	const keys = Object.keys(left)
	return (
		keys.length === Object.keys(right).length &&
		keys.every((key) => key in right && valuesEqual(left[key], right[key], depth - 1))
	)
}

/**
 * Whether two element trees would draw the same thing: same types and keys, equal props, with
 * function props taken as equal and plain objects compared two levels down. It lets a settled turn
 * skip a render when the parent hands over a freshly built but identical action row.
 */
export function renderedEqual(a: ReactNode, b: ReactNode): boolean {
	if (Object.is(a, b)) return true
	if (!isValidElement(a) || !isValidElement(b))
		return Array.isArray(a) ? valuesEqual(a, b, 2) : false
	if (a.type !== b.type || a.key !== b.key) return false
	return valuesEqual(a.props, b.props, 2)
}
