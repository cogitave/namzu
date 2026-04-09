import type { DocumentId, KnowledgeBaseId } from '../ids/index.js'
import type { DocumentMetadata, TenantScope } from './scope.js'

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
	): Promise<IngestionResult>

	remove(documentId: DocumentId): Promise<void>
}
