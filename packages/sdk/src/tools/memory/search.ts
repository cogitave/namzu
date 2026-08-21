import { z } from 'zod'
import type {
	MemoryIndex,
	MemorySearchParams,
	MemorySearchResult,
	MemoryStore,
} from '../../types/memory/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'

type SearchMemory = (params: MemorySearchParams) => MemorySearchResult | Promise<MemorySearchResult>

function defineSearchMemoryTool(search: SearchMemory): ToolDefinition {
	return defineTool({
		name: 'search_memory',
		description:
			'Search stored memories by query, tags, or status. Returns titles and summaries only — use read_memory for full content.',
		inputSchema: z.object({
			query: z.string().optional().describe('Search query to match against titles and summaries'),
			tags: z.array(z.string()).optional().describe('Filter by tags (all must match)'),
			limit: z.number().positive().default(10).describe('Maximum results to return'),
		}),
		category: 'analysis',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		async execute({ query, tags, limit }) {
			const result = await search({ query, tags, limit })

			if (result.entries.length === 0) {
				return {
					success: true,
					output: 'No memories found.',
					data: { entries: [], totalCount: 0 },
				}
			}

			const lines = result.entries.map(
				(e, i) =>
					`${i + 1}. [${e.id}] ${e.title} — ${e.summary}${e.tags.length > 0 ? ` [${e.tags.join(', ')}]` : ''}`,
			)

			const output =
				result.totalCount > result.entries.length
					? `Found ${result.totalCount} memories (showing ${result.entries.length}):\n${lines.join('\n')}`
					: `Found ${result.totalCount} memories:\n${lines.join('\n')}`

			return {
				success: true,
				output,
				data: {
					entries: result.entries,
					totalCount: result.totalCount,
				},
			}
		},
	})
}

/** Build search over a caller-owned, already-ready synchronous index. */
export function buildSearchMemoryTool(index: MemoryIndex): ToolDefinition {
	return defineSearchMemoryTool((params) => index.search(params))
}

/** Build search over the store's authoritative asynchronous read boundary. */
export function buildStoreSearchMemoryTool(store: MemoryStore): ToolDefinition {
	return defineSearchMemoryTool((params) => store.list(params))
}
