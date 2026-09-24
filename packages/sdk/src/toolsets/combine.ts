import type { ToolDefinition } from '../types/tool/index.js'
import type { ToolSource, Toolset } from './types.js'

/**
 * Two toolsets (or one toolset, twice) contributed a tool with the same
 * name, and `combineToolsets` cannot decide which one wins.
 *
 * Named, and carrying both sources, for the reason `ToolNameCollisionError`
 * (`registry/tool/execute.ts`) is: a caller that wants to handle this —
 * rename one side, refuse the whole config — has to be able to catch it
 * narrowly and read who collided, not match on message text. There is no
 * `RegistryCollisionError` base in this branch yet (plan.md's `ToolRegistry`
 * removal item may add one and have this extend it); until then this stands
 * alone, with the same name/message/fields shape so that move costs nothing
 * but a superclass.
 */
export class ToolsetConflictError extends Error {
	readonly toolName: string
	readonly firstSource: ToolSource
	readonly secondSource: ToolSource

	constructor(toolName: string, firstSource: ToolSource, secondSource: ToolSource) {
		const detail =
			firstSource.id === secondSource.id
				? `toolset "${firstSource.id}" contributes it more than once`
				: `it is contributed by both "${firstSource.id}" and "${secondSource.id}"`
		super(
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
 * tool order — the same rule plan.md gives `ToolRegistry.toLLMTools`.
 *
 * `onChange`/`close` are defined only if at least one inner toolset defines
 * them — this never fabricates a live capability none of its inputs have.
 * `onChange`'s listener is handed straight to every inner toolset that has
 * one; the returned unsubscribe tears down every one of those
 * subscriptions, so a change three layers down still reaches it and
 * unsubscribing here cleans up all of them.
 */
export function combineToolsets(source: ToolSource | string, toolsets: readonly Toolset[]): Toolset {
	const resolvedSource: ToolSource = typeof source === 'string' ? { id: source, kind: 'host_tool', name: source } : source

	const combined: Toolset = {
		source: resolvedSource,
		tools: () => mergeTools(toolsets),
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
