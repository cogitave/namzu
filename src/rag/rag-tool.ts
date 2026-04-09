import { z } from 'zod'
import { defineTool } from '../tools/defineTool.js'
import type { KnowledgeBaseId } from '../types/ids/index.js'
import type { RAGToolConfig } from '../types/rag/index.js'
import { assembleRAGContext } from './context-assembler.js'

const ragInputSchema = z.object({
	query: z.string().min(1).describe('The search query to find relevant knowledge'),
	knowledge_base_id: z.string().optional().describe('ID of a specific knowledge base to search'),
	top_k: z.number().int().min(1).max(20).optional().describe('Number of results to retrieve'),
})

export function createRAGTool(config: RAGToolConfig) {
	return defineTool({
		name: 'knowledge_search',
		description:
			'Search the knowledge base for relevant information. Use this tool when you need to find specific facts, documentation, or context that may be stored in the knowledge base.',
		inputSchema: ragInputSchema,
		category: 'analysis',
		permissions: ['network_access'],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,

		async execute(input) {
			const kbId =
				(input.knowledge_base_id as KnowledgeBaseId | undefined) ?? config.defaultKnowledgeBaseId
			const kb = kbId
				? config.knowledgeBases.get(kbId)
				: config.knowledgeBases.values().next().value

			if (!kb) {
				return {
					success: false,
					output: '',
					error: `Knowledge base not found: ${kbId ?? 'none configured'}`,
				}
			}

			const result = await kb.query({
				text: input.query,
				config: { topK: input.top_k ?? config.topK ?? 5 },
			})

			if (result.chunks.length === 0) {
				return {
					success: true,
					output: 'No relevant information found in the knowledge base for this query.',
				}
			}

			const context = assembleRAGContext(result.chunks, config.contextConfig)

			return {
				success: true,
				output: context.content,
				data: {
					sources: context.sources,
					mode: result.mode,
					durationMs: result.durationMs,
				},
			}
		},
	})
}
