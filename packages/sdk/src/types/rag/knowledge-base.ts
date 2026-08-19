import type { DocumentId, KnowledgeBaseId, TenantId } from '../ids/index.js'
import type { ChunkingConfig } from './chunking.js'
import type { EmbeddingConfig } from './embedding.js'
import type { IngestionResult } from './ingestion.js'
import type { RetrievalConfig, RetrievalQuery, RetrievalResult } from './retrieval.js'
import type { DocumentMetadata, RAGOperationOptions } from './scope.js'

export interface KnowledgeBaseConfig {
	id?: KnowledgeBaseId
	name: string
	description?: string
	tenantId: TenantId
	namespace?: string
	chunking?: Partial<ChunkingConfig>
	retrieval?: Partial<RetrievalConfig>
	embedding?: EmbeddingConfig
}

export interface KnowledgeBase {
	readonly id: KnowledgeBaseId
	readonly config: KnowledgeBaseConfig

	ingest(
		content: string,
		metadata?: DocumentMetadata,
		options?: RAGOperationOptions,
	): Promise<IngestionResult>
	remove(documentId: DocumentId): Promise<void>
	query(query: RetrievalQuery, options?: RAGOperationOptions): Promise<RetrievalResult>
	clear(): Promise<void>
}
