import { RegistryCollisionError } from '../registry/collision.js'
import type { ToolDefinition } from '../types/tool/index.js'
import type { ToolSource, Toolset, ToolsetAvailability } from './types.js'

/**
 * Two toolsets (or one toolset, twice) contributed a tool with the same
 * name, and `combineToolsets` cannot decide which one wins.
 *
 * Named, and carrying both sources, for the reason `ToolNameCollisionError`
 * (`registry/tool/execute.ts`) is: a caller that wants to handle this —
 * rename one side, refuse the whole config — has to be able to catch it
 * narrowly and read who collided, not match on message text. Extends
 * `RegistryCollisionError` (`registry/collision.ts`) like every other
 * `*CollisionError`, with `combineToolsets` as the "registry" name and the
 * tool name as the colliding id; `firstSource`/`secondSource` are this
 * class's own addition, since a plain `RegistryCollisionError` has nowhere
 * to carry two whole sources.
 */
export class ToolsetConflictError extends RegistryCollisionError {
	readonly toolName: string
	readonly firstSource: ToolSource
	readonly secondSource: ToolSource

	constructor(toolName: string, firstSource: ToolSource, secondSource: ToolSource) {
		const detail =
			firstSource.id === secondSource.id
				? `toolset "${firstSource.id}" contributes it more than once`
				: `it is contributed by both "${firstSource.id}" and "${secondSource.id}"`
		super(
			'combineToolsets',
			toolName,
			`combineToolsets: tool name "${toolName}" is not unique — ${detail}. Wrap one contributor with prefixed(toolset, prefix) (or renamed(toolset, { ${toolName}: "..." })) before combining.`,
		)
		this.name = 'ToolsetConflictError'
		this.toolName = toolName
		this.firstSource = firstSource
		this.secondSource = secondSource
	}
}

/**
 * Merge toolsets into one, under a new umbrella `source`.
 *
 * Atomic: `tools()` either returns the full merged list or throws
 * {@link ToolsetConflictError} — never a partial list. Every call
 * recomputes from the inner toolsets' current `tools()`, so this composes
 * with live sources: a name that only collides after an inner toolset's
 * `onChange` fires is caught the next time `tools()` is called, exactly
 * like any other change.
 *
 * Order is deterministic: toolset order (as given), then each toolset's own
 * tool order — the same rule `ToolManager` uses.
 *
 * `onChange`/`close` are defined only if at least one inner toolset defines
 * them — this never fabricates a live capability none of its inputs have.
 * `onChange`'s listener is handed straight to every inner toolset that has
 * one; the returned unsubscribe tears down every one of those
 * subscriptions, so a change three layers down still reaches it and
 * unsubscribing here cleans up all of them.
 */
export function combineToolsets(
	source: ToolSource | string,
	toolsets: readonly Toolset[],
): Toolset {
	const resolvedSource: ToolSource =
		typeof source === 'string' ? { id: source, kind: 'host_tool', name: source } : source
	// Omitted rather than set to `'active'`: absent already means `'active'`
	// (`Toolset.availability`'s own doc comment), so this only adds the field
	// for the one case worth stating explicitly — every input agreeing on
	// `'deferred'`.
	const availability = uniformAvailability(resolvedSource.id, toolsets)

	const combined: Toolset = {
		source: resolvedSource,
		tools: () => mergeTools(toolsets),
		...(availability === 'deferred' ? { availability } : {}),
	}

	const liveOnChange = toolsets
		.map((inner) => inner.onChange)
		.filter((onChange): onChange is NonNullable<typeof onChange> => onChange !== undefined)
	if (liveOnChange.length > 0) {
		combined.onChange = (listener) => {
			const unsubscribes = liveOnChange.map((onChange) => onChange(listener))
			return () => {
				for (const unsubscribe of unsubscribes) unsubscribe()
			}
		}
	}

	const closeFns = toolsets
		.map((inner) => inner.close)
		.filter((close): close is NonNullable<typeof close> => close !== undefined)
	if (closeFns.length > 0) {
		combined.close = async () => {
			await Promise.all(closeFns.map((close) => close()))
		}
	}

	return combined
}

/**
 * The one `availability` a merged toolset may report, or `undefined` when
 * there is nothing to report (no inputs).
 *
 * A `Toolset` has exactly one `availability` for every tool it contributes —
 * there is no per-tool field, and `ToolManager` derives a name's default
 * from whichever ARRAY ENTRY owns it (`manager.ts`'s `availability`; the
 * same rule `runtime/query/index.ts` documents at its own two-entry
 * `runtime:active`/`runtime:deferred` split, which it keeps unmerged for
 * exactly this reason). Silently defaulting a mixed merge to `'active'`
 * would misreport every `deferred` input's tools as always active, with
 * nothing in the returned `Toolset` to say so. So a mix throws here,
 * naming the two sources that disagree, rather than combining them.
 */
function uniformAvailability(
	combinedId: string,
	toolsets: readonly Toolset[],
): ToolsetAvailability | undefined {
	let agreed:
		| { readonly availability: ToolsetAvailability; readonly source: ToolSource }
		| undefined
	for (const inner of toolsets) {
		const availability = inner.availability ?? 'active'
		if (!agreed) {
			agreed = { availability, source: inner.source }
			continue
		}
		if (agreed.availability !== availability) {
			throw new Error(
				`combineToolsets("${combinedId}"): "${agreed.source.id}" is ${agreed.availability} and "${inner.source.id}" is ${availability}. combineToolsets reports one availability for the whole merged toolset, so combining toolsets that disagree would silently report the deferred side's tools as active. Combine toolsets that share an availability, or keep the eager and deferred halves as separate entries in the caller's own toolsets array instead of merging them.`,
			)
		}
	}
	return agreed?.availability
}

function mergeTools(toolsets: readonly Toolset[]): ToolDefinition[] {
	const ownerByToolName = new Map<string, ToolSource>()
	const merged: ToolDefinition[] = []
	for (const inner of toolsets) {
		for (const tool of inner.tools()) {
			const owner = ownerByToolName.get(tool.name)
			if (owner) throw new ToolsetConflictError(tool.name, owner, inner.source)
			ownerByToolName.set(tool.name, inner.source)
			merged.push(tool)
		}
	}
	return merged
}
