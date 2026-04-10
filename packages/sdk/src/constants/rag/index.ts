import type {
	ChunkingConfig,
	ChunkingStrategy,
	RAGContextConfig,
	RetrievalConfig,
} from '../../types/rag/index.js'

export const DEFAULT_SEPARATORS: Record<ChunkingStrategy, string[]> = {
	fixed: [],
	sentence: ['. ', '! ', '? ', '.\n', '!\n', '?\n'],
	paragraph: ['\n\n', '\n'],
	recursive: ['\n\n', '\n', '. ', ' ', ''],
}

export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
	strategy: 'recursive',
	chunkSize: 512,
	chunkOverlap: 64,
}

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
	mode: 'vector',
	topK: 5,
	minScore: 0.3,
	hybridAlpha: 0.7,
}

export const DEFAULT_RAG_CONTEXT_CONFIG: RAGContextConfig = {
	maxTokens: 4096,
	separator: '\n\n---\n\n',
	includeMetadata: true,
	headerTemplate:
		'## Retrieved Knowledge\n\nThe following information was retrieved from the knowledge base:\n',
}
