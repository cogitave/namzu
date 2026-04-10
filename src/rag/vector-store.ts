import type { ChunkId, DocumentId, KnowledgeBaseId } from '../types/ids/index.js'
import type {
	Chunk,
	VectorSearchResult,
	VectorStore,
	VectorStoreQuery,
} from '../types/rag/index.js'

export class InMemoryVectorStore implements VectorStore {
	private chunks: Map<ChunkId, Chunk> = new Map()

	async upsert(chunks: Chunk[]): Promise<void> {
		for (const chunk of chunks) {
			this.chunks.set(chunk.id, chunk)
		}
	}

	async search(query: VectorStoreQuery): Promise<VectorSearchResult[]> {
		const candidates: VectorSearchResult[] = []

		for (const chunk of this.chunks.values()) {
			if (chunk.tenantId !== query.tenantId) continue
			if (query.knowledgeBaseId && chunk.knowledgeBaseId !== query.knowledgeBaseId) continue
			if (!chunk.embedding) continue

			if (query.filter) {
				let matches = true
				for (const [key, value] of Object.entries(query.filter)) {
					if (chunk.metadata[key] !== value) {
						matches = false
						break
					}
				}
				if (!matches) continue
			}

			const score = cosineSimilarity(query.embedding, chunk.embedding)
			if (query.minScore !== undefined && score < query.minScore) continue
			candidates.push({ chunk, score })
		}

		candidates.sort((a, b) => b.score - a.score)
		return candidates.slice(0, query.topK)
	}

	async delete(chunkIds: ChunkId[]): Promise<void> {
		for (const id of chunkIds) {
			this.chunks.delete(id)
		}
	}

	async deleteByDocument(documentId: DocumentId): Promise<void> {
		for (const [id, chunk] of this.chunks) {
			if (chunk.documentId === documentId) {
				this.chunks.delete(id)
			}
		}
	}

	async deleteByKnowledgeBase(knowledgeBaseId: KnowledgeBaseId, tenantId: string): Promise<void> {
		for (const [id, chunk] of this.chunks) {
			if (chunk.knowledgeBaseId === knowledgeBaseId && chunk.tenantId === tenantId) {
				this.chunks.delete(id)
			}
		}
	}
}

export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length) return 0

	let dotProduct = 0
	let normA = 0
	let normB = 0

	for (let i = 0; i < a.length; i++) {
		const ai = a[i]
		const bi = b[i]
		if (ai === undefined || bi === undefined) break
		dotProduct += ai * bi
		normA += ai * ai
		normB += bi * bi
	}

	const denominator = Math.sqrt(normA) * Math.sqrt(normB)
	return denominator === 0 ? 0 : dotProduct / denominator
}
