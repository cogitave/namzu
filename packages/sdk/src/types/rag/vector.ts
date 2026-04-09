import type { ChunkId, DocumentId, KnowledgeBaseId } from '../ids/index.js'
import type { Chunk } from './storage.js'

export interface VectorSearchResult {
	chunk: Chunk
	score: number
}

export interface VectorStoreQuery {
	embedding: number[]
	topK: number
	tenantId: string
	knowledgeBaseId?: KnowledgeBaseId
	filter?: Record<string, unknown>
	minScore?: number
}

export interface VectorStore {
	upsert(chunks: Chunk[]): Promise<void>
	search(query: VectorStoreQuery): Promise<VectorSearchResult[]>
	delete(chunkIds: ChunkId[]): Promise<void>
	deleteByDocument(documentId: DocumentId): Promise<void>
	deleteByKnowledgeBase(knowledgeBaseId: KnowledgeBaseId, tenantId: string): Promise<void>
}
