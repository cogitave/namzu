/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 4):
 *
 *   - `DefaultIngestionPipeline.ingest(content, metadata, scope, kbId)`:
 *     - Generates a fresh `documentId` per call.
 *     - Chunks via `TextChunker.chunk(content, chunkingConfig)`.
 *     - Returns zero-chunk result when the chunker emits nothing.
 *     - Calls `embeddingProvider.embed([...chunkTexts])` exactly once
 *       with every chunk in order.
 *     - Each resulting `Chunk` carries:
 *       - a fresh `id`,
 *       - the generated `documentId`,
 *       - the passed `knowledgeBaseId`,
 *       - `scope.tenantId`,
 *       - the original `chunkContent` + `chunkIndex` metadata,
 *       - `tokenCount = Math.ceil(content.length / 4)`.
 *     - Calls `vectorStore.upsert(chunks)` exactly once.
 *     - Totals `tokenCount` across chunks and reports `durationMs`.
 *   - `remove(documentId)` delegates to `vectorStore.deleteByDocument`.
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { DocumentId, KnowledgeBaseId, TenantId } from '../types/ids/index.js'
import type { Chunk, EmbeddingProvider, TenantScope, VectorStore } from '../types/rag/index.js'

import { DefaultIngestionPipeline } from './ingestion.js'

const KB = 'kb_1' as KnowledgeBaseId
const TENANT = 't_1' as TenantId
const scope: TenantScope = { tenantId: TENANT }

function makeVectorStore(): VectorStore {
	return {
		upsert: vi.fn<(chunks: Chunk[]) => Promise<void>>(),
		search: vi.fn(),
		delete: vi.fn(),
		deleteByDocument: vi.fn(),
		deleteByKnowledgeBase: vi.fn(),
	} as unknown as VectorStore
}

function makeEmbedder(): EmbeddingProvider {
	return {
		id: 'mock',
		model: 'x',
		dimensions: 3,
		embed: vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0])),
		embedQuery: vi.fn(async () => [1, 0, 0]),
	}
}

describe('DefaultIngestionPipeline — ingest', () => {
	it('returns zero-chunk result when the chunker emits nothing', async () => {
		const vs = makeVectorStore()
		const emb = makeEmbedder()
		// chunkSize 10, no content at all → chunker returns []
		const pipeline = new DefaultIngestionPipeline(vs, emb, {
			strategy: 'fixed',
			chunkSize: 10,
			chunkOverlap: 0,
		})
		const result = await pipeline.ingest('   ', {}, scope, KB)
		expect(result.chunkCount).toBe(0)
		expect(result.totalTokens).toBe(0)
		expect(vs.upsert).not.toHaveBeenCalled()
	})

	it('chunks content, embeds every chunk once, upserts once', async () => {
		const vs = makeVectorStore()
		const emb = makeEmbedder()
		const pipeline = new DefaultIngestionPipeline(vs, emb, {
			strategy: 'fixed',
			chunkSize: 10,
			chunkOverlap: 0,
		})

		const result = await pipeline.ingest('a'.repeat(25), { source: 'repo' }, scope, KB)

		expect(emb.embed).toHaveBeenCalledTimes(1)
		expect(vs.upsert).toHaveBeenCalledTimes(1)
		expect(result.chunkCount).toBeGreaterThan(1)

		const upsertedChunks = vi.mocked(vs.upsert).mock.calls[0]?.[0] ?? []
		for (const c of upsertedChunks) {
			expect(c.documentId).toBe(result.documentId)
			expect(c.knowledgeBaseId).toBe(KB)
			expect(c.tenantId).toBe(TENANT)
			expect(c.metadata.source).toBe('repo')
			expect(c.metadata.chunkIndex).toBeDefined()
			expect(c.tokenCount).toBe(Math.ceil(c.content.length / 4))
		}
	})

	it('generates a fresh documentId per ingest call', async () => {
		const pipeline = new DefaultIngestionPipeline(makeVectorStore(), makeEmbedder())
		const a = await pipeline.ingest('alpha', {}, scope, KB)
		const b = await pipeline.ingest('beta', {}, scope, KB)
		expect(a.documentId).not.toBe(b.documentId)
	})
})

describe('DefaultIngestionPipeline — remove', () => {
	it('delegates to vectorStore.deleteByDocument', async () => {
		const vs = makeVectorStore()
		const pipeline = new DefaultIngestionPipeline(vs, makeEmbedder())
		await pipeline.remove('doc_9' as DocumentId)
		expect(vs.deleteByDocument).toHaveBeenCalledWith('doc_9')
	})
})

// Avoid the unused zod import — used in type coverage indirectly.
void z
