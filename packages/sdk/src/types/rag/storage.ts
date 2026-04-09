import type { ChunkId, DocumentId, KnowledgeBaseId } from '../ids/index.js'
import type { DocumentMetadata } from './scope.js'

export interface Document {
	id: DocumentId
	knowledgeBaseId: KnowledgeBaseId
	tenantId: string
	content: string
	metadata: DocumentMetadata
	createdAt: number
	updatedAt: number
}

export interface Chunk {
	id: ChunkId
	documentId: DocumentId
	knowledgeBaseId: KnowledgeBaseId
	tenantId: string
	content: string
	index: number
	tokenCount: number
	embedding?: number[]
	metadata: DocumentMetadata
	createdAt: number
}
