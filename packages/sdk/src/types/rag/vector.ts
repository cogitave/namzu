import type { ChunkId, DocumentId, KnowledgeBaseId, TenantId } from '../ids/index.js'
import type { Chunk } from './storage.js'

export interface VectorSearchResult {
	chunk: Chunk
	score: number
}

export interface VectorStoreQuery {
	embedding: number[]
	topK: number
	tenantId: TenantId
	knowledgeBaseId?: KnowledgeBaseId
	/**
	 * The partition to search. Matched by equality, INCLUDING absence.
	 *
	 * An omitted namespace means "the default partition", not "no filter".
	 * Reading it as "no filter" is how an isolation boundary leaks: a caller
	 * who never asked for a namespace would see every namespaced chunk in
	 * the tenant, which is the opposite of what partitioning is for. A
	 * caller who genuinely wants everything asks the store for each
	 * namespace it holds.
	 */
	namespace?: string
	filter?: Record<string, unknown>
	minScore?: number
}

export interface VectorStore {
	upsert(chunks: Chunk[]): Promise<void>
	search(query: VectorStoreQuery): Promise<VectorSearchResult[]>
	delete(chunkIds: ChunkId[]): Promise<void>
	deleteByDocument(documentId: DocumentId): Promise<void>
	deleteByKnowledgeBase(knowledgeBaseId: KnowledgeBaseId, tenantId: TenantId): Promise<void>
}
