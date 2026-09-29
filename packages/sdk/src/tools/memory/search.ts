import { z } from 'zod'
import { describeMemoryAge } from '../../store/memory/links.js'
import type {
	MemoryIndex,
	MemorySearchParams,
	MemorySearchResult,
	MemoryStore,
} from '../../types/memory/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'

type SearchMemory = (params: MemorySearchParams) => MemorySearchResult | Promise<MemorySearchResult>
const MAX_MEMORY_SCAN = 256

function defineSearchMemoryTool(search: SearchMemory): ToolDefinition {
	return defineTool({
		name: 'search_memory',
		description:
			'Search active stored memories by relevant words or tags. The built-in stores rank matches in names, titles, descriptions, summaries and full content. Built-in search examines at most 256 recent candidates per call; if incomplete, continue with the returned scan_offset. Use read_memory for evidence. Set status to archived to inspect obsolete records.',
		inputSchema: z.object({
			query: z.string().optional().describe('Relevant words or identifiers to search'),
			tags: z.array(z.string()).optional().describe('Filter by tags (all must match)'),
			status: z
				.enum(['active', 'archived'])
				.default('active')
				.describe('Which memories to search; archived for obsolete records'),
			limit: z
				.number()
				.int()
				.min(1)
				.max(50)
				.default(10)
				.describe('Maximum results to return (1–50)'),
			scan_offset: z
				.number()
				.int()
				.min(0)
				.default(0)
				.describe('Candidate offset from an earlier incomplete search; starts at 0'),
		}),
		category: 'analysis',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		async execute({ query, tags, status, limit, scan_offset }) {
			const result = await search({
				query,
				tags,
				status,
				limit,
				maxScanned: MAX_MEMORY_SCAN,
				scanOffset: scan_offset,
			})
			const continuation = result.truncated
				? result.nextScanOffset === undefined
					? ' Search incomplete; narrow the query or read a known ID.'
					: ` Search incomplete; continue with scan_offset ${result.nextScanOffset}.`
				: ''
			const page = scan_offset > 0 || result.truncated ? ' in this scan page' : ''

			if (result.entries.length === 0) {
				return {
					success: true,
					output: `No memories found${page}.${continuation}`,
					data: {
						entries: [],
						totalCount: result.totalCount,
						truncated: result.truncated === true,
						...(result.scannedCount !== undefined ? { scannedCount: result.scannedCount } : {}),
						...(result.nextScanOffset !== undefined
							? { nextScanOffset: result.nextScanOffset }
							: {}),
					},
				}
			}

			const now = Date.now()
			const lines = result.entries.map((e, i) => {
				const kind = [e.name, e.type, describeMemoryAge(e.updatedAt, now)]
					.filter(Boolean)
					.join(', ')
				return `${i + 1}. [${e.id}] ${e.title} (${kind}) — ${e.description ?? e.summary}${e.tags.length > 0 ? ` [${e.tags.join(', ')}]` : ''}`
			})

			const output =
				result.totalCount > result.entries.length
					? `Found ${result.totalCount} memories${page} (showing ${result.entries.length}):\n${lines.join('\n')}${continuation}`
					: `Found ${result.totalCount} memories${page}:\n${lines.join('\n')}${continuation}`

			return {
				success: true,
				output,
				data: {
					entries: result.entries,
					totalCount: result.totalCount,
					truncated: result.truncated === true,
					...(result.scannedCount !== undefined ? { scannedCount: result.scannedCount } : {}),
					...(result.nextScanOffset !== undefined ? { nextScanOffset: result.nextScanOffset } : {}),
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
