import type { ChunkId, DocumentId, KnowledgeBaseId, TenantId } from '../ids/index.js'
import type { DocumentMetadata } from './scope.js'

export interface Document {
	id: DocumentId
	knowledgeBaseId: KnowledgeBaseId
	tenantId: TenantId
	content: string
	metadata: DocumentMetadata
	createdAt: number
	updatedAt: number
}

export interface Chunk {
	id: ChunkId
	documentId: DocumentId
	knowledgeBaseId: KnowledgeBaseId
	tenantId: TenantId
	/**
	 * The partition this chunk was ingested into, from `TenantScope`.
	 *
	 * `TenantScope.namespace` and `KnowledgeBaseConfig.namespace` were both
	 * declared from the start and neither reached storage: ingestion copied
	 * `scope.tenantId` onto every chunk and dropped the namespace, so a
	 * partition a host had asked for did not exist at all.
	 */
	namespace?: string
	content: string
	index: number
	tokenCount: number
	embedding?: number[]
	metadata: DocumentMetadata
	createdAt: number
}
