/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 4):
 *
 *   - `DefaultRetriever.retrieve(query, scope, kbId)` dispatches by
 *     `effectiveConfig.mode` (query.config overrides instance config).
 *   - Query expansion: if `recentMessages` is present and non-empty,
 *     appends the last 3 messages joined with spaces after a
 *     `\n\nContext: ` marker. Otherwise passes `query.text` verbatim.
 *   - `vector` mode: embeds the (expanded) query once, forwards
 *     `{embedding, topK, tenantId, knowledgeBaseId, minScore}` to the
 *     store, returns store results unchanged.
 *   - `keyword` mode: fetches `topK * 2` results from vector search with
 *     `minScore: 0`, then rescores via BM25 against the query's
 *     tokenized form. Filters score > 0, sorts desc, slices to topK.
 *     Tokenization: lowercase, strip non-`\w\s`, split by whitespace,
 *     drop tokens length ≤ 1.
 *   - `hybrid` mode: runs vector + keyword in parallel, merges by
 *     `chunk.id`, weights vector by `alpha` and keyword by `1 - alpha`
 *     (default alpha = 0.7). Sorts desc, slices to topK.
 *   - Result shape: `{chunks, query, expandedQuery?, mode, durationMs}`.
 *     `expandedQuery` is omitted when equal to original `query.text`.
 *   - Unknown mode would hit the exhaustive throw (unreachable via
 *     types; not asserted).
 */

import { describe, expect, it, vi } from 'vitest'

import type { ChunkId, DocumentId, KnowledgeBaseId, TenantId } from '../types/ids/index.js'
import type {
	Chunk,
	EmbeddingProvider,
	TenantScope,
	VectorSearchResult,
	VectorStore,
} from '../types/rag/index.js'

import { DefaultRetriever } from './retriever.js'

const TENANT = 't_1' as TenantId
const KB = 'kb_1' as KnowledgeBaseId
const scope: TenantScope = { tenantId: TENANT }

function chunk(id: string, content: string): Chunk {
	return {
		id: id as ChunkId,
		documentId: 'doc_1' as DocumentId,
		knowledgeBaseId: KB,
		tenantId: TENANT,
		content,
		index: 0,
		tokenCount: 0,
		embedding: [1, 0, 0],
		metadata: {},
		createdAt: 0,
	}
}

function r(id: string, content: string, score: number): VectorSearchResult {
	return { chunk: chunk(id, content), score }
}

function makeStore(searchResults: VectorSearchResult[]): VectorStore {
	return {
		search: vi.fn(async () => searchResults),
		upsert: vi.fn(),
		delete: vi.fn(),
		deleteByDocument: vi.fn(),
		deleteByKnowledgeBase: vi.fn(),
	}
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

describe('DefaultRetriever — vector mode', () => {
	it('forwards embedded query + topK + tenant + minScore to store', async () => {
		const store = makeStore([r('a', 'x', 0.9)])
		const emb = makeEmbedder()
		const retriever = new DefaultRetriever(store, emb, {
			mode: 'vector',
			topK: 3,
			minScore: 0.2,
		})
		await retriever.retrieve({ text: 'hi' }, scope, KB)
		expect(store.search).toHaveBeenCalledWith(
			expect.objectContaining({
				embedding: [1, 0, 0],
				topK: 3,
				tenantId: TENANT,
				knowledgeBaseId: KB,
				minScore: 0.2,
			}),
		)
	})

	it('returns mode + durationMs + chunks without mutation', async () => {
		const results = [r('a', 'x', 0.9)]
		const store = makeStore(results)
		const retriever = new DefaultRetriever(store, makeEmbedder(), {
			mode: 'vector',
			topK: 5,
		})
		const out = await retriever.retrieve({ text: 'hi' }, scope)
		expect(out.mode).toBe('vector')
		expect(out.chunks).toEqual(results)
		expect(typeof out.durationMs).toBe('number')
	})
})

describe('DefaultRetriever — query expansion', () => {
	it('when recentMessages exists, appends "Context: " + last 3 joined', async () => {
		const store = makeStore([])
		const emb = makeEmbedder()
		const retriever = new DefaultRetriever(store, emb, { mode: 'vector', topK: 3 })

		const out = await retriever.retrieve(
			{ text: 'query', recentMessages: ['m1', 'm2', 'm3', 'm4'] },
			scope,
		)
		expect(out.expandedQuery).toBe('query\n\nContext: m2 m3 m4')
		expect(emb.embedQuery).toHaveBeenCalledWith('query\n\nContext: m2 m3 m4')
	})

	it('when no recentMessages, expandedQuery is undefined (original == expanded)', async () => {
		const store = makeStore([])
		const retriever = new DefaultRetriever(store, makeEmbedder(), {
			mode: 'vector',
			topK: 3,
		})
		const out = await retriever.retrieve({ text: 'plain' }, scope)
		expect(out.expandedQuery).toBeUndefined()
	})
})

describe('DefaultRetriever — keyword mode', () => {
	it('fetches 2*topK from store, rescores via BM25, slices to topK', async () => {
		// 6 candidate chunks (topK * 2 with topK=3) — retriever requests 2*topK with minScore 0.
		const store = makeStore([
			r('a', 'apple orange', 0.1),
			r('b', 'banana apple apple', 0.1),
			r('c', 'unrelated text', 0.1),
			r('d', 'apple apple apple', 0.1),
			r('e', 'nothing here', 0.1),
			r('f', 'apple', 0.1),
		])
		const retriever = new DefaultRetriever(store, makeEmbedder(), {
			mode: 'keyword',
			topK: 3,
		})
		const out = await retriever.retrieve({ text: 'apple' }, scope)
		expect(out.chunks.length).toBeLessThanOrEqual(3)
		expect(out.chunks.every((c) => c.score > 0)).toBe(true)
		// Tokenization: 'nothing' + 'here' — doesn't contain 'apple' → score 0 → filtered.
		expect(out.chunks.every((c) => c.chunk.id !== ('e' as ChunkId))).toBe(true)
	})

	it('query store is called with minScore: 0 + topK*2', async () => {
		const store = makeStore([r('a', 'apple', 0.5)])
		const retriever = new DefaultRetriever(store, makeEmbedder(), {
			mode: 'keyword',
			topK: 2,
		})
		await retriever.retrieve({ text: 'apple' }, scope)
		expect(store.search).toHaveBeenCalledWith(expect.objectContaining({ topK: 4, minScore: 0 }))
	})
})

describe('DefaultRetriever — hybrid mode', () => {
	it('merges by chunk.id, weighted by alpha (default 0.7)', async () => {
		const store = makeStore([r('a', 'apple', 1), r('b', 'banana', 0.5)])
		const retriever = new DefaultRetriever(store, makeEmbedder(), {
			mode: 'hybrid',
			topK: 5,
		})
		const out = await retriever.retrieve({ text: 'apple' }, scope)
		// Vector side: a=0.7, b=0.35. Keyword side (BM25): a matches → >0; b=0.
		// Hybrid: a stays high; b gets only vector weight.
		expect(out.chunks[0]?.chunk.id).toBe('a')
	})

	it('chunks in only one side still appear with partial weight', async () => {
		const store = makeStore([r('a', 'apple', 1)])
		const retriever = new DefaultRetriever(store, makeEmbedder(), {
			mode: 'hybrid',
			topK: 5,
		})
		const out = await retriever.retrieve({ text: 'apple' }, scope)
		expect(out.chunks.length).toBe(1)
		expect(out.chunks[0]?.score).toBeGreaterThan(0)
	})
})

describe('DefaultRetriever — config merge', () => {
	it('query.config overrides instance config per-call', async () => {
		const store = makeStore([r('a', 'x', 0.9)])
		const retriever = new DefaultRetriever(store, makeEmbedder(), {
			mode: 'vector',
			topK: 5,
		})
		await retriever.retrieve({ text: 'hi', config: { topK: 1 } }, scope)
		expect(store.search).toHaveBeenCalledWith(expect.objectContaining({ topK: 1 }))
	})
})
