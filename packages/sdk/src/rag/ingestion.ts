import type { DocumentId, KnowledgeBaseId } from '../types/ids/index.js'
import type {
	Chunk,
	ChunkingConfig,
	DocumentMetadata,
	EmbeddingProvider,
	IngestionPipeline,
	IngestionResult,
	RAGOperationOptions,
	TenantScope,
	VectorStore,
} from '../types/rag/index.js'
import { generateChunkId, generateDocumentId } from '../utils/id.js'
import { DEFAULT_CHUNKING_CONFIG, TextChunker } from './chunking.js'
import { awaitRAGOperation } from './operation.js'

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
		options?: RAGOperationOptions,
	): Promise<IngestionResult> {
		options?.signal?.throwIfAborted()
		const startTime = Date.now()
		const documentId = generateDocumentId()

		const chunkContents = this.chunker.chunk(content, this.chunkingConfig)
		if (chunkContents.length === 0) {
			return { documentId, chunkCount: 0, totalTokens: 0, durationMs: Date.now() - startTime }
		}

		const texts = chunkContents.map((c) => c.content)
		const embeddings = options
			? await this.embeddingProvider.embed(texts, options)
			: await this.embeddingProvider.embed(texts)
		// A custom provider may accept the signal yet settle successfully after
		// cancellation. Its cooperation is outside the kernel's control; whether
		// Namzu now persists those late results is not. Recheck before the first
		// state-changing store call.
		options?.signal?.throwIfAborted()

		const now = Date.now()
		const chunks: Chunk[] = chunkContents.map((cc, i) => ({
			id: generateChunkId(),
			documentId,
			knowledgeBaseId,
			tenantId: scope.tenantId,
			...(scope.namespace !== undefined ? { namespace: scope.namespace } : {}),
			content: cc.content,
			index: cc.index,
			tokenCount: estimateTokens(cc.content),
			embedding: embeddings[i],
			metadata: { ...metadata, chunkIndex: cc.index },
			createdAt: now,
		}))

		const upsert = options
			? this.vectorStore.upsert(chunks, options)
			: this.vectorStore.upsert(chunks)
		await awaitRAGOperation(upsert, options?.signal)

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
