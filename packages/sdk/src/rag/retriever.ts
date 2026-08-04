import { DEFAULT_RETRIEVAL_CONFIG } from '../constants/rag/index.js'
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

export { DEFAULT_RETRIEVAL_CONFIG }

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
		if (!query.recentMessages || query.recentMessages.length === 0) {
			return query.text
		}

		const recentContext = query.recentMessages.slice(-3).join(' ')
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
			...(scope.namespace !== undefined ? { namespace: scope.namespace } : {}),
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
			...(scope.namespace !== undefined ? { namespace: scope.namespace } : {}),
			knowledgeBaseId,
			minScore: 0,
		})

		const queryTerms = this.tokenize(query)

		// BM25 needs corpus statistics, so tokenize the whole candidate set
		// first: document frequency per term for IDF, and the real average
		// document length for the length normalization. Both used to be
		// missing — IDF entirely, and `avgDl` as a hardcoded 256 that had
		// nothing to do with these documents.
		const tokenized = vectorResults.map((result) => this.tokenize(result.chunk.content))
		const stats = buildCorpusStats(tokenized)

		return vectorResults
			.map((result, i) => ({
				...result,
				score: bm25Score(queryTerms, tokenized[i] as string[], stats),
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

		// Put both rankings on the same scale before blending. Cosine is
		// bounded, BM25 is not, so the raw mix let the larger scale win
		// regardless of `alpha`.
		for (const result of normalizeByMax(vectorResults)) {
			scoreMap.set(result.chunk.id, {
				chunk: result.chunk,
				score: alpha * result.score,
			})
		}

		for (const result of normalizeByMax(keywordResults)) {
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
}

interface CorpusStats {
	/** Number of documents in the candidate set. */
	readonly n: number
	/** Mean document length, in tokens. */
	readonly avgDl: number
	/** How many documents contain each term. */
	readonly df: ReadonlyMap<string, number>
}

function buildCorpusStats(docs: readonly string[][]): CorpusStats {
	const df = new Map<string, number>()
	let totalLength = 0

	for (const doc of docs) {
		totalLength += doc.length
		for (const term of new Set(doc)) {
			df.set(term, (df.get(term) ?? 0) + 1)
		}
	}

	return { n: docs.length, avgDl: docs.length === 0 ? 1 : totalLength / docs.length, df }
}

/**
 * Okapi BM25.
 *
 * The previous implementation had the term-frequency saturation half and no
 * IDF at all, which is the half that does the discriminating: without it
 * every matched term is worth the same, so a chunk matching three common
 * words outscores the one chunk containing the rare term the query was
 * actually about. It also normalized document length against a hardcoded
 * `avgDl = 256` rather than the corpus in front of it, so the `b` term was
 * measuring against a number with no relationship to these documents.
 *
 * IDF uses the standard Robertson/Sparck-Jones form with 0.5 smoothing,
 * wrapped in `ln(1 + x)` so a term appearing in EVERY document scores a
 * small positive weight rather than the negative one the unwrapped form
 * produces when `df > n/2`.
 */
function bm25Score(queryTerms: string[], docTerms: string[], stats: CorpusStats): number {
	const k1 = 1.2
	const b = 0.75
	const dl = docTerms.length

	const termFreq = new Map<string, number>()
	for (const term of docTerms) {
		termFreq.set(term, (termFreq.get(term) ?? 0) + 1)
	}

	let score = 0
	for (const term of queryTerms) {
		const tf = termFreq.get(term) ?? 0
		if (tf === 0) continue

		const df = stats.df.get(term) ?? 0
		const idf = Math.log(1 + (stats.n - df + 0.5) / (df + 0.5))

		const numerator = tf * (k1 + 1)
		const denominator = tf + k1 * (1 - b + b * (dl / stats.avgDl))
		score += idf * (numerator / denominator)
	}

	return score
}

/**
 * Rescale scores into [0, 1] by their maximum.
 *
 * Cosine similarity is bounded and BM25 is not, so blending them with a
 * fixed `alpha` compared quantities on different scales — a BM25 of 7.4
 * against a cosine of 0.83 meant `alpha` did not weight the two halves, it
 * just let whichever scale happened to be larger win. Normalizing each
 * ranking to its own maximum makes `alpha` mean what its name says.
 */
function normalizeByMax(
	results: readonly VectorSearchResult[],
): { chunk: VectorSearchResult['chunk']; score: number }[] {
	const max = results.reduce((m, r) => Math.max(m, r.score), 0)
	if (max <= 0) return results.map((r) => ({ chunk: r.chunk, score: 0 }))
	return results.map((r) => ({ chunk: r.chunk, score: r.score / max }))
}
