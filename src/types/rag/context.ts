import type { DocumentId, KnowledgeBaseId } from '../ids/index.js'
import type { KnowledgeBase } from './knowledge-base.js'

export interface RAGToolInput {
	query: string
	knowledgeBaseId?: string
	topK?: number
}

export interface RAGContextConfig {
	maxTokens: number
	separator: string
	includeMetadata: boolean
	headerTemplate?: string
}

export interface RAGContext {
	content: string
	sources: Array<{ documentId: DocumentId; chunk: string; score: number }>
	tokenCount: number
}

export interface RAGToolConfig {
	knowledgeBases: Map<string, KnowledgeBase>
	defaultKnowledgeBaseId?: KnowledgeBaseId
	contextConfig?: Partial<RAGContextConfig>
	topK?: number
}
