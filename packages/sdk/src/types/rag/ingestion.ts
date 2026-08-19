import type { DocumentId, KnowledgeBaseId } from '../ids/index.js'
import type { DocumentMetadata, RAGOperationOptions, TenantScope } from './scope.js'

export interface IngestionResult {
	documentId: DocumentId
	chunkCount: number
	totalTokens: number
	durationMs: number
}

export interface IngestionPipeline {
	ingest(
		content: string,
		metadata: DocumentMetadata,
		scope: TenantScope,
		knowledgeBaseId: KnowledgeBaseId,
		options?: RAGOperationOptions,
	): Promise<IngestionResult>

	remove(documentId: DocumentId): Promise<void>
}
