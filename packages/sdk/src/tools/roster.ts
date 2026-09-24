/**
 * Narrower rosters from a wider one.
 *
 * A delegate that can only look, or a file-defined agent with an allowlist,
 * needs a registry that is the parent's minus something — and every host
 * that builds delegates wrote the same two loops. They live here so the
 * predicate for "read-only" is the one the authorization gate and the
 * prompt exemption already use (`isTrustedReadOnly`), not a third reading
 * of the same flag.
 *
 * Both filters INTERSECT: a name in an allowlist that the source does not
 * carry is simply not there. A filter can never widen.
 */

import { ToolRegistry } from '../registry/tool/execute.js'
import type { ToolDefinition, ToolRegistryContract } from '../types/tool/index.js'
import { isTrustedReadOnly } from './trusted-read-only.js'

/**
 * The tools that declare themselves read-only and are trusted to say so.
 *
 * Decided by `isTrustedReadOnly` with no input, which is each tool's own
 * declaration: a new read-only builtin joins the roster without this file
 * learning its name, and a connected server's tool that merely CLAIMS to be
 * read-only stays out unless its provenance is trusted.
 */
export function filterReadOnlyTools(source: ToolRegistryContract): ToolRegistry {
	const filtered = new ToolRegistry()
	for (const tool of source.getAll()) {
		if (isTrustedReadOnly(tool, undefined)) filtered.register(tool)
	}
	return filtered
}

/** The tools whose names are listed. Names the source does not carry are ignored. */
export function filterToolsNamed(
	source: ToolRegistryContract,
	names: Iterable<string>,
): ToolRegistry {
	const allowed = new Set(names)
	const filtered = new ToolRegistry()
	for (const tool of source.getAll()) {
		if (allowed.has(tool.name)) filtered.register(tool)
	}
	return filtered
}

/**
 * How a capability, toolset wrapper or host names the tools it wants,
 * without maintaining a parallel name list of its own:
 *
 * - a list of exact tool names;
 * - a partial match against `ToolDefinition.metadata` — every key the
 *   selector names must be present, with a deep-equal value (a nested plain
 *   object recurses the same way); a key the tool's metadata does not carry,
 *   or carries a different value for, fails the match. An empty object
 *   selector matches every tool;
 * - a predicate, for anything the two shapes above cannot express.
 *
 * Synchronous only, unlike Pydantic AI's `ToolSelector` (which also allows an
 * async predicate): every place namzu filters a roster today does so
 * synchronously, and an `Awaitable` branch nothing calls is a surface with
 * nothing to test.
 */
export type ToolSelector =
	| readonly string[]
	| Readonly<Record<string, unknown>>
	| ((tool: ToolDefinition) => boolean)

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
	}
	if (isPlainObject(a) && isPlainObject(b)) {
		const keysA = Object.keys(a)
		const keysB = Object.keys(b)
		return keysA.length === keysB.length && keysA.every((key) => deepEqual(a[key], b[key]))
	}
	return false
}

/** Every key `expected` names is present in `actual` with a deep-equal value. */
function metadataIncludes(
	actual: Readonly<Record<string, unknown>> | undefined,
	expected: Readonly<Record<string, unknown>>,
): boolean {
	const keys = Object.keys(expected)
	if (keys.length === 0) return true
	if (!actual) return false
	return keys.every((key) => {
		const expectedValue = expected[key]
		const actualValue = actual[key]
		return isPlainObject(expectedValue) && isPlainObject(actualValue)
			? metadataIncludes(actualValue, expectedValue)
			: deepEqual(actualValue, expectedValue)
	})
}

/**
 * Whether `tool` matches `selector`: a name list, a metadata deep-match, or a
 * predicate — see {@link ToolSelector}. Never reads anything but `tool.name`
 * and `tool.metadata`, so it never sees a tool's schema or execution.
 */
export function matchesToolSelector(selector: ToolSelector, tool: ToolDefinition): boolean {
	if (typeof selector === 'function') return selector(tool)
	if (Array.isArray(selector)) return selector.includes(tool.name)
	return metadataIncludes(tool.metadata, selector as Readonly<Record<string, unknown>>)
}
