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
			'Search active stored memories by relevant words or tags. The built-in store ranks matches in titles, summaries and full content. Returns titles and summaries; use read_memory for evidence. Set status to archived to inspect obsolete records.',
		inputSchema: z.object({
			query: z.string().optional().describe('Relevant words or identifiers to search'),
			tags: z.array(z.string()).optional().describe('Filter by tags (all must match)'),
			status: z.enum(['active', 'archived']).default('active'),
			limit: z
				.number()
				.int()
				.min(1)
				.max(50)
				.default(10)
				.describe('Maximum results to return (1–50)'),
		}),
		category: 'analysis',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		async execute({ query, tags, status, limit }) {
			const result = await search({ query, tags, status, limit })

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
