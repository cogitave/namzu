import type { DocumentId, KnowledgeBaseId } from '../types/ids/index.js'
import type {
	ChunkingConfig,
	DocumentMetadata,
	EmbeddingProvider,
	IngestionResult,
	KnowledgeBase,
	KnowledgeBaseConfig,
	RetrievalConfig,
	RetrievalQuery,
	RetrievalResult,
	TenantScope,
	VectorStore,
} from '../types/rag/index.js'
import { generateKnowledgeBaseId } from '../utils/id.js'
import { DEFAULT_CHUNKING_CONFIG } from './chunking.js'
import { DefaultIngestionPipeline } from './ingestion.js'
import { DEFAULT_RETRIEVAL_CONFIG, DefaultRetriever } from './retriever.js'

export class DefaultKnowledgeBase implements KnowledgeBase {
	readonly id: KnowledgeBaseId
	readonly config: KnowledgeBaseConfig

	private readonly ingestion: DefaultIngestionPipeline
	private readonly retriever: DefaultRetriever
	private readonly scope: TenantScope
	private readonly vectorStore: VectorStore

	constructor(
		config: KnowledgeBaseConfig,
		vectorStore: VectorStore,
		embeddingProvider: EmbeddingProvider,
	) {
		this.vectorStore = vectorStore
		this.id = config.id ?? generateKnowledgeBaseId()
		this.config = { ...config, id: this.id }

		this.scope = {
			tenantId: config.tenantId,
			namespace: config.namespace,
		}

		const chunkingConfig: ChunkingConfig = {
			...DEFAULT_CHUNKING_CONFIG,
			...config.chunking,
		}

		const retrievalConfig: RetrievalConfig = {
			...DEFAULT_RETRIEVAL_CONFIG,
			...config.retrieval,
		}

		this.ingestion = new DefaultIngestionPipeline(vectorStore, embeddingProvider, chunkingConfig)
		this.retriever = new DefaultRetriever(vectorStore, embeddingProvider, retrievalConfig)
	}

	async ingest(content: string, metadata: DocumentMetadata = {}): Promise<IngestionResult> {
		return this.ingestion.ingest(content, metadata, this.scope, this.id)
	}

	async remove(documentId: DocumentId): Promise<void> {
		return this.ingestion.remove(documentId)
	}

	async query(query: RetrievalQuery): Promise<RetrievalResult> {
		return this.retriever.retrieve(query, this.scope, this.id)
	}

	async clear(): Promise<void> {
		await this.vectorStore.deleteByKnowledgeBase(this.id, this.scope.tenantId)
	}
}
