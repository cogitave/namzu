import type { ToolDefinition } from '../types/tool/index.js'
import type { ToolSource, Toolset } from './types.js'

/**
 * The plain, static `Toolset`: a fixed list of tools from one source.
 *
 * A bare string source is shorthand for a `host_tool` source with that
 * string as both `id` and `name` — the common case for a small, in-process
 * bundle of tools ("builtin", "memory") that has no separate discovery
 * metadata worth writing out. Anything that needs a real `kind`
 * (`mcp_server`, `plugin`, …) passes a full {@link ToolSource}; string
 * shorthand never guesses a kind from the text of the id.
 *
 * The tools array is snapshotted once, at construction, so a caller that
 * mutates the array it passed in afterward cannot change what this toolset
 * reports. There is no `onChange`: a plain toolset never changes on its
 * own — wrap it with a live source (a future MCP toolset) or rebuild it
 * with a new snapshot instead.
 */
export function toolset(source: ToolSource | string, tools: readonly ToolDefinition[]): Toolset {
	const resolvedSource = typeof source === 'string' ? hostToolSource(source) : source
	const snapshot = tools.slice()
	return {
		source: resolvedSource,
		tools: () => snapshot,
	}
}

function hostToolSource(id: string): ToolSource {
	return { id, kind: 'host_tool', name: id }
}
