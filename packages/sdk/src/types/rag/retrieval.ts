import type { KnowledgeBaseId } from '../ids/index.js'
import type { ProjectId } from '../session/ids.js'
import type { RAGOperationOptions, TenantScope } from './scope.js'
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
	/**
	 * **Not consulted.** No chunk carries a project, so there is nothing to
	 * match it against: ingestion stamps a tenant and a namespace, and
	 * `KnowledgeBaseConfig` has no project field to stamp a third from.
	 *
	 * Left declared and said out loud rather than quietly filtering on it.
	 * Wiring one end of an isolation dimension is worse than wiring
	 * neither — a query that filters against a value nothing writes returns
	 * zero rows, and "no results" reads as "nothing matched" rather than
	 * "this scope does not exist". Partition with
	 * {@link TenantScope.namespace}, which is stamped at ingest and matched
	 * at search.
	 *
	 * @deprecated Use `TenantScope.namespace` until a project reaches
	 * ingestion.
	 */
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
		options?: RAGOperationOptions,
	): Promise<RetrievalResult>
}
