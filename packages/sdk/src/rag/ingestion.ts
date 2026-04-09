import type { DocumentId, KnowledgeBaseId } from '../types/ids/index.js'
import type {
	Chunk,
	ChunkingConfig,
	DocumentMetadata,
	EmbeddingProvider,
	IngestionPipeline,
	IngestionResult,
	TenantScope,
	VectorStore,
} from '../types/rag/index.js'
import { generateChunkId, generateDocumentId } from '../utils/id.js'
import { DEFAULT_CHUNKING_CONFIG, TextChunker } from './chunking.js'

export class DefaultIngestionPipeline implements IngestionPipeline {
	private readonly chunker: TextChunker
	private readonly chunkingConfig: ChunkingConfig

	constructor(
		private readonly vectorStore: VectorStore,
		private readonly embeddingProvider: EmbeddingProvider,
		chunkingConfig?: Partial<ChunkingConfig>,
	) {
		this.chunker = new TextChunker()
		this.chunkingConfig = { ...DEFAULT_CHUNKING_CONFIG, ...chunkingConfig }
	}

	async ingest(
		content: string,
		metadata: DocumentMetadata,
		scope: TenantScope,
		knowledgeBaseId: KnowledgeBaseId,
	): Promise<IngestionResult> {
		const startTime = Date.now()
		const documentId = generateDocumentId()

		const chunkContents = this.chunker.chunk(content, this.chunkingConfig)
		if (chunkContents.length === 0) {
			return { documentId, chunkCount: 0, totalTokens: 0, durationMs: Date.now() - startTime }
		}

		const texts = chunkContents.map((c) => c.content)
		const embeddings = await this.embeddingProvider.embed(texts)

		const now = Date.now()
		const chunks: Chunk[] = chunkContents.map((cc, i) => ({
			id: generateChunkId(),
			documentId,
			knowledgeBaseId,
			tenantId: scope.tenantId,
			content: cc.content,
			index: cc.index,
			tokenCount: estimateTokens(cc.content),
			embedding: embeddings[i],
			metadata: { ...metadata, chunkIndex: cc.index },
			createdAt: now,
		}))

		await this.vectorStore.upsert(chunks)

		const totalTokens = chunks.reduce((sum, c) => sum + c.tokenCount, 0)
		return {
			documentId,
			chunkCount: chunks.length,
			totalTokens,
			durationMs: Date.now() - startTime,
		}
	}

	async remove(documentId: DocumentId): Promise<void> {
		await this.vectorStore.deleteByDocument(documentId)
	}
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4)
}
