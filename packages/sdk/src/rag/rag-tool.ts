import { z } from 'zod'
import { defineTool } from '../tools/defineTool.js'
import type { RAGToolConfig } from '../types/rag/index.js'
import { asKnowledgeBaseId } from '../utils/id.js'
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

		async execute(input, toolContext) {
			const kbId =
				(input.knowledge_base_id === undefined
					? undefined
					: asKnowledgeBaseId(input.knowledge_base_id)) ?? config.defaultKnowledgeBaseId
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

			const query = {
				text: input.query,
				config: { topK: input.top_k ?? config.topK ?? 5 },
			}
			const result = toolContext.abortSignal
				? await kb.query(query, { signal: toolContext.abortSignal })
				: await kb.query(query)

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
