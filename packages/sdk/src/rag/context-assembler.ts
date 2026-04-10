import { DEFAULT_RAG_CONTEXT_CONFIG } from '../constants/rag/index.js'
import type { RAGContext, RAGContextConfig, VectorSearchResult } from '../types/rag/index.js'

export { DEFAULT_RAG_CONTEXT_CONFIG }

export function assembleRAGContext(
	results: VectorSearchResult[],
	config: Partial<RAGContextConfig> = {},
): RAGContext {
	const effectiveConfig = { ...DEFAULT_RAG_CONTEXT_CONFIG, ...config }

	if (results.length === 0) {
		return { content: '', sources: [], tokenCount: 0 }
	}

	const sources: RAGContext['sources'] = []
	const parts: string[] = []

	if (effectiveConfig.headerTemplate) {
		parts.push(effectiveConfig.headerTemplate)
	}

	let currentTokens = estimateTokens(parts.join(''))

	for (const result of results) {
		const chunkTokens = estimateTokens(result.chunk.content)
		if (currentTokens + chunkTokens > effectiveConfig.maxTokens) break

		let entry = result.chunk.content

		if (effectiveConfig.includeMetadata) {
			const meta = formatMetadata(result)
			entry = `${meta}\n${entry}`
		}

		parts.push(entry)
		currentTokens += chunkTokens

		sources.push({
			documentId: result.chunk.documentId,
			chunk: result.chunk.content.slice(0, 200),
			score: result.score,
		})
	}

	const content = parts.join(effectiveConfig.separator)
	return { content, sources, tokenCount: estimateTokens(content) }
}

function formatMetadata(result: VectorSearchResult): string {
	const meta = result.chunk.metadata
	const parts: string[] = []
	if (meta.source) parts.push(`Source: ${meta.source}`)
	if (meta.title) parts.push(`Title: ${meta.title}`)
	parts.push(`Relevance: ${(result.score * 100).toFixed(1)}%`)
	return `[${parts.join(' | ')}]`
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4)
}
