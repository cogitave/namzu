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
	content: string
	index: number
	tokenCount: number
	embedding?: number[]
	metadata: DocumentMetadata
	createdAt: number
}
