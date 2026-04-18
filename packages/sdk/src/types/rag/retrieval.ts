import type { KnowledgeBaseId } from '../ids/index.js'
import type { ProjectId } from '../session/ids.js'
import type { TenantScope } from './scope.js'
import type { VectorSearchResult } from './vector.js'

export type RetrievalMode = 'vector' | 'keyword' | 'hybrid'

export interface RetrievalConfig {
	mode: RetrievalMode
	topK: number
	minScore?: number
	hybridAlpha?: number
}

export interface RetrievalQuery {
	text: string
	projectId?: ProjectId
	recentMessages?: string[]
	config?: Partial<RetrievalConfig>
}

export interface RetrievalResult {
	chunks: VectorSearchResult[]
	query: string
	expandedQuery?: string
	mode: RetrievalMode
	durationMs: number
}

export interface Retriever {
	retrieve(
		query: RetrievalQuery,
		scope: TenantScope,
		knowledgeBaseId?: KnowledgeBaseId,
	): Promise<RetrievalResult>
}
