import type { ToolDefinition } from '../types/tool/index.js'
import { matchesSourceIdGlob } from './source-glob.js'
import type { ToolFilterSelector, ToolPredicate, Toolset, ToolsetAvailability } from './types.js'

/**
 * Build a derived `Toolset` that keeps the inner toolset's `source`,
 * `availability` (unless overridden) and live-update wiring (`onChange`,
 * `close`), forwarded rather than re-implemented.
 *
 * Every wrapper in this file goes through this one function, so "keep the
 * inner source", "forward `onChange` through every layer" and "clean up
 * `close`" are each written exactly once.
 */
function deriveToolset(
	ts: Toolset,
	overrides: {
		tools?: () => readonly ToolDefinition[]
		availability?: ToolsetAvailability
	},
): Toolset {
	const derived: Toolset = {
		source: ts.source,
		tools: overrides.tools ?? (() => ts.tools()),
		availability: overrides.availability ?? ts.availability,
	}
	if (ts.onChange) {
		// A direct forward: calling the derived toolset's `onChange` subscribes
		// the inner one with the same listener and hands back ITS unsubscribe,
		// so a change three layers down reaches the outermost listener, and
		// unsubscribing at any layer tears down exactly that subscription.
		const innerOnChange = ts.onChange
		derived.onChange = (listener) => innerOnChange(listener)
	}
	if (ts.close) {
		const innerClose = ts.close
		derived.close = () => innerClose()
	}
	return derived
}

/**
 * Apply `fn` to every tool this toolset contributes, recomputed on every
 * `tools()` call (no caching) so a live inner toolset's change is visible
 * immediately. Every other wrapper below is written in terms of this one.
 */
export function mapTools(ts: Toolset, fn: (tool: ToolDefinition) => ToolDefinition): Toolset {
	return deriveToolset(ts, { tools: () => ts.tools().map(fn) })
}

/** Prepend `prefix` to every tool's name. `execute` and every other field are untouched. */
export function prefixed(ts: Toolset, prefix: string): Toolset {
	return mapTools(ts, (tool) => ({ ...tool, name: `${prefix}${tool.name}` }))
}

/**
 * Rename the tools named as keys in `names` to their mapped value. A tool
 * whose name is not a key keeps its name. `execute` and every other field
 * are untouched — only `name` changes.
 */
export function renamed(ts: Toolset, names: Readonly<Record<string, string>>): Toolset {
	return mapTools(ts, (tool) => {
		const next = names[tool.name]
		return next === undefined ? tool : { ...tool, name: next }
	})
}

/**
 * Keep only the tools `selector` (or `predicate`) admits.
 *
 * See {@link ToolFilterSelector} for what a non-function selector can match
 * on. A `sourceIdGlob` selector is all-or-nothing per toolset — it tests
 * this toolset's own `source.id`, not a per-tool source, because no
 * per-tool source exists yet (plan.md §3, a later item).
 */
export function filtered(ts: Toolset, selector: ToolFilterSelector | ToolPredicate): Toolset {
	const predicate = toPredicate(ts, selector)
	return deriveToolset(ts, { tools: () => ts.tools().filter(predicate) })
}

function toPredicate(ts: Toolset, selector: ToolFilterSelector | ToolPredicate): ToolPredicate {
	if (typeof selector === 'function') return selector
	if (Array.isArray(selector)) {
		const names = new Set<string>(selector as readonly string[])
		return (tool) => names.has(tool.name)
	}
	// `Array.isArray`'s built-in guard narrows against a MUTABLE `any[]`, so
	// TypeScript cannot use the negative case above to drop `readonly
	// string[]` from the union — the cast is just naming what the runtime
	// check already proved.
	const objectSelector = selector as Exclude<ToolFilterSelector, readonly string[]>
	if ('sourceIdGlob' in objectSelector) {
		const keepEverything = matchesSourceIdGlob(ts.source.id, objectSelector.sourceIdGlob)
		return () => keepEverything
	}
	const pattern = objectSelector.metadata
	return (tool) => tool.metadata !== undefined && metadataIncludes(tool.metadata, pattern)
}

/**
 * Deep-match: every key in `pattern` must be present and equal on `actual`,
 * recursing into nested plain objects and comparing arrays elementwise (see
 * plan.md gaps/no-open-metadata-and-selector.md for the selector design this
 * generalizes). A `pattern` value that is neither a plain object nor an
 * array must match `actual` exactly (`Object.is`).
 */
function metadataIncludes(actual: Readonly<Record<string, unknown>>, pattern: Readonly<Record<string, unknown>>): boolean {
	return Object.entries(pattern).every(([key, expected]) => valueIncludes(actual[key], expected))
}

function valueIncludes(actual: unknown, expected: unknown): boolean {
	if (isPlainObject(expected) && isPlainObject(actual)) {
		return metadataIncludes(actual as Record<string, unknown>, expected as Record<string, unknown>)
	}
	if (Array.isArray(expected) && Array.isArray(actual)) {
		return actual.length === expected.length && expected.every((item, index) => valueIncludes(actual[index], item))
	}
	return Object.is(actual, expected)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * This toolset's tools default to `'deferred'` instead of `'active'` — the
 * model has to ask for them by name (or a `search_tools`/reveal path) rather
 * than seeing them offered up front.
 */
export function deferred(ts: Toolset): Toolset {
	return deriveToolset(ts, { availability: 'deferred' })
}

/**
 * Mark the tools `selector` admits (every tool, when omitted) as needing
 * approval every time they are called.
 *
 * Sets `ToolDefinition.requiresApproval` and nothing else — this wrapper
 * does not enforce approval; that is item A2's job in
 * `registry/tool/execute.ts`. A toolset built with this wrapper carries the
 * declaration; a runtime that has not landed A2 yet simply has an unread
 * field on the tools it executes.
 */
export function requireApproval(ts: Toolset, selector?: ToolFilterSelector | ToolPredicate): Toolset {
	const predicate = selector ? toPredicate(ts, selector) : () => true
	return mapTools(ts, (tool) => (predicate(tool) ? { ...tool, requiresApproval: true } : tool))
}

/**
 * Merge `metadata` onto every tool this toolset contributes, keeping
 * whatever metadata a tool already carries (last write wins per key).
 */
export function withMetadata(ts: Toolset, metadata: Readonly<Record<string, unknown>>): Toolset {
	return mapTools(ts, (tool) => ({ ...tool, metadata: { ...tool.metadata, ...metadata } }))
}
