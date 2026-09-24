import { matchesToolSelector } from '../tools/roster.js'
import type { ToolDefinition } from '../types/tool/index.js'
import { matchesSourceIdGlob } from './source-glob.js'
import {
	type ToolFilterSelector,
	type ToolPredicate,
	type Toolset,
	type ToolsetAvailability,
	toToolSourceRef,
} from './types.js'

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
 * per-tool source exists yet (plan.md §3, a later item). A function
 * `predicate` is handed `ts.source` (projected through
 * {@link toToolSourceRef}) as its second argument for the same reason —
 * see {@link ToolPredicate}'s note on what that source means, and does not
 * mean, once toolsets have been combined.
 */
export function filtered(ts: Toolset, selector: ToolFilterSelector | ToolPredicate): Toolset {
	const predicate = toPredicate(ts, selector)
	const source = toToolSourceRef(ts.source)
	return deriveToolset(ts, { tools: () => ts.tools().filter((tool) => predicate(tool, source)) })
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
	// The deep-match itself (nested plain objects recursed, arrays compared
	// elementwise) is `matchesToolSelector`'s (`tools/roster.ts`) — the same
	// rule a permission `by_source`/metadata rule matches by, so a metadata
	// selector means the same thing wherever it is written.
	const pattern = objectSelector.metadata
	return (tool) => matchesToolSelector(pattern, tool)
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
 * Sets `ToolDefinition.requiresApproval` to a predicate that always answers
 * `true`, and nothing else — this wrapper does not enforce approval itself;
 * that is `runtime/query/review-policy.ts`'s job, which reads the field this
 * writes. `requiresApproval` is declared as `(input: TInput) => boolean`
 * (method-shorthand, like `isReadOnly`), not a plain boolean, so every tool
 * this wrapper marks gets the same always-true predicate rather than a
 * second field shape to check for.
 */
export function requireApproval(
	ts: Toolset,
	selector?: ToolFilterSelector | ToolPredicate,
): Toolset {
	const predicate = selector ? toPredicate(ts, selector) : () => true
	const source = toToolSourceRef(ts.source)
	const mapped = new WeakMap<ToolDefinition, ToolDefinition>()
	return deriveToolset(ts, {
		tools: () =>
			ts.tools().map((tool) => {
				if (!predicate(tool, source)) return tool
				let approved = mapped.get(tool)
				if (!approved) {
					approved = { ...tool, requiresApproval: () => true }
					mapped.set(tool, approved)
				}
				return approved
			}),
	})
}

/**
 * Merge `metadata` onto every tool this toolset contributes, keeping
 * whatever metadata a tool already carries (last write wins per key).
 */
export function withMetadata(ts: Toolset, metadata: Readonly<Record<string, unknown>>): Toolset {
	return mapTools(ts, (tool) => ({ ...tool, metadata: { ...tool.metadata, ...metadata } }))
}
