import type { KnowledgeBaseId } from '../types/ids/index.js'
import type {
	EmbeddingProvider,
	RetrievalConfig,
	RetrievalQuery,
	RetrievalResult,
	Retriever,
	TenantScope,
	VectorSearchResult,
	VectorStore,
} from '../types/rag/index.js'

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
	mode: 'vector',
	topK: 5,
	minScore: 0.3,
	hybridAlpha: 0.7,
}

export class DefaultRetriever implements Retriever {
	constructor(
		private readonly vectorStore: VectorStore,
		private readonly embeddingProvider: EmbeddingProvider,
		private readonly config: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG,
	) {}

	async retrieve(
		query: RetrievalQuery,
		scope: TenantScope,
		knowledgeBaseId?: KnowledgeBaseId,
	): Promise<RetrievalResult> {
		const startTime = Date.now()
		const effectiveConfig = { ...this.config, ...query.config }
		const expandedQuery = this.expandQuery(query)

		let chunks: VectorSearchResult[]

		switch (effectiveConfig.mode) {
			case 'vector':
				chunks = await this.vectorSearch(expandedQuery, scope, knowledgeBaseId, effectiveConfig)
				break
			case 'keyword':
				chunks = await this.keywordSearch(expandedQuery, scope, knowledgeBaseId, effectiveConfig)
				break
			case 'hybrid':
				chunks = await this.hybridSearch(expandedQuery, scope, knowledgeBaseId, effectiveConfig)
				break
			default: {
				const _exhaustive: never = effectiveConfig.mode
				throw new Error(`Unhandled retrieval mode: ${_exhaustive}`)
			}
		}

		return {
			chunks,
			query: query.text,
			expandedQuery: expandedQuery !== query.text ? expandedQuery : undefined,
			mode: effectiveConfig.mode,
			durationMs: Date.now() - startTime,
		}
	}

	private expandQuery(query: RetrievalQuery): string {
		if (!query.threadMessages || query.threadMessages.length === 0) {
			return query.text
		}

		const recentContext = query.threadMessages.slice(-3).join(' ')
		return `${query.text}\n\nContext: ${recentContext}`
	}

	private async vectorSearch(
		query: string,
		scope: TenantScope,
		knowledgeBaseId: KnowledgeBaseId | undefined,
		config: RetrievalConfig,
	): Promise<VectorSearchResult[]> {
		const embedding = await this.embeddingProvider.embedQuery(query)
		return this.vectorStore.search({
			embedding,
			topK: config.topK,
			tenantId: scope.tenantId,
			knowledgeBaseId,
			minScore: config.minScore,
		})
	}

	private async keywordSearch(
		query: string,
		scope: TenantScope,
		knowledgeBaseId: KnowledgeBaseId | undefined,
		config: RetrievalConfig,
	): Promise<VectorSearchResult[]> {
		const embedding = await this.embeddingProvider.embedQuery(query)
		const vectorResults = await this.vectorStore.search({
			embedding,
			topK: config.topK * 2,
			tenantId: scope.tenantId,
			knowledgeBaseId,
			minScore: 0,
		})

		const queryTerms = this.tokenize(query)
		return vectorResults
			.map((result) => ({
				...result,
				score: this.bm25Score(queryTerms, this.tokenize(result.chunk.content)),
			}))
			.filter((r) => r.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, config.topK)
	}

	private async hybridSearch(
		query: string,
		scope: TenantScope,
		knowledgeBaseId: KnowledgeBaseId | undefined,
		config: RetrievalConfig,
	): Promise<VectorSearchResult[]> {
		const alpha = config.hybridAlpha ?? 0.7

		const [vectorResults, keywordResults] = await Promise.all([
			this.vectorSearch(query, scope, knowledgeBaseId, { ...config, topK: config.topK * 2 }),
			this.keywordSearch(query, scope, knowledgeBaseId, { ...config, topK: config.topK * 2 }),
		])

		const scoreMap = new Map<string, { chunk: VectorSearchResult['chunk']; score: number }>()

		for (const result of vectorResults) {
			scoreMap.set(result.chunk.id, {
				chunk: result.chunk,
				score: alpha * result.score,
			})
		}

		for (const result of keywordResults) {
			const existing = scoreMap.get(result.chunk.id)
			if (existing) {
				existing.score += (1 - alpha) * result.score
			} else {
				scoreMap.set(result.chunk.id, {
					chunk: result.chunk,
					score: (1 - alpha) * result.score,
				})
			}
		}

		return [...scoreMap.values()].sort((a, b) => b.score - a.score).slice(0, config.topK)
	}

	private tokenize(text: string): string[] {
		return text
			.toLowerCase()
			.replace(/[^\w\s]/g, ' ')
			.split(/\s+/)
			.filter((t) => t.length > 1)
	}

	private bm25Score(queryTerms: string[], docTerms: string[]): number {
		const k1 = 1.2
		const b = 0.75
		const avgDl = 256
		const dl = docTerms.length

		const termFreq = new Map<string, number>()
		for (const term of docTerms) {
			termFreq.set(term, (termFreq.get(term) ?? 0) + 1)
		}

		let score = 0
		for (const term of queryTerms) {
			const tf = termFreq.get(term) ?? 0
			if (tf === 0) continue
			const numerator = tf * (k1 + 1)
			const denominator = tf + k1 * (1 - b + b * (dl / avgDl))
			score += numerator / denominator
		}

		return score
	}
}
