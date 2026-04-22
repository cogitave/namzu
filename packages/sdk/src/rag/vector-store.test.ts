/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 4):
 *
 *   This file doubles as the VectorStore contract — the tests here run
 *   against `InMemoryVectorStore` as the reference implementation, and
 *   are the spec a future `@namzu/vector-store-conformance` package will
 *   be built around (D4 ratification + Q5 refinement: contract first,
 *   not "whatever the reference happens to do").
 *
 *   **VectorStore contract (derived from current code, 2026-04-21):**
 *
 *   - `upsert(chunks[])`: stores each chunk keyed by `chunk.id`. Re-upsert
 *     of a chunk with the same id REPLACES — no merge, no error. Tenant
 *     scoping is carried on each chunk, not enforced at upsert (the
 *     caller is trusted).
 *   - `search(query)`: returns `VectorSearchResult[]`:
 *     - Filters by `tenantId` (EXACT match).
 *     - If `knowledgeBaseId` is set, filters by that too.
 *     - Skips chunks with `embedding === undefined`.
 *     - Applies `filter` as metadata-equality AND across the whole
 *       filter object.
 *     - Computes similarity via `cosineSimilarity(query, chunk.embedding)`.
 *     - If `minScore` is set, drops scores below it.
 *     - Sorts descending by score and returns the top `topK` results.
 *   - `delete(chunkIds[])`: deletes by exact chunk id. Unknown ids are
 *     silently ignored.
 *   - `deleteByDocument(documentId)`: NOT tenant-scoped in the
 *     current API — deletes every chunk with matching `documentId`
 *     ACROSS tenants. This is an asymmetry with `search` /
 *     `deleteByKnowledgeBase` and is intentional to pin (Codex #9 flag).
 *   - `deleteByKnowledgeBase(kbId, tenantId)`: tenant-scoped deletion
 *     by knowledge base.
 *   - `cosineSimilarity(a, b)`: returns 0 when arrays differ in length
 *     OR when either has zero norm. Otherwise returns the standard
 *     dot-product / (‖a‖·‖b‖) result.
 */

import { describe, expect, it } from 'vitest'

import type { ChunkId, DocumentId, KnowledgeBaseId, TenantId } from '../types/ids/index.js'
import type { Chunk, VectorStoreQuery } from '../types/rag/index.js'

import { InMemoryVectorStore, cosineSimilarity } from './vector-store.js'

const T1 = 'tenant_1' as TenantId
const T2 = 'tenant_2' as TenantId
const KB1 = 'kb_1' as KnowledgeBaseId
const KB2 = 'kb_2' as KnowledgeBaseId
const D1 = 'doc_1' as DocumentId
const D2 = 'doc_2' as DocumentId

function chunk(id: string, overrides: Partial<Chunk> = {}): Chunk {
	return {
		id: id as ChunkId,
		documentId: D1,
		knowledgeBaseId: KB1,
		tenantId: T1,
		content: `content of ${id}`,
		index: 0,
		tokenCount: 10,
		embedding: [1, 0, 0],
		metadata: {},
		createdAt: Date.now(),
		...overrides,
	}
}

const baseQuery: VectorStoreQuery = {
	embedding: [1, 0, 0],
	topK: 10,
	tenantId: T1,
}

describe('InMemoryVectorStore — upsert', () => {
	it('stores chunks by id; re-upsert replaces', async () => {
		const s = new InMemoryVectorStore()
		await s.upsert([chunk('c1', { content: 'v1' })])
		await s.upsert([chunk('c1', { content: 'v2' })])
		const results = await s.search(baseQuery)
		expect(results).toHaveLength(1)
		expect(results[0]?.chunk.content).toBe('v2')
	})
})

describe('InMemoryVectorStore — search', () => {
	it('enforces tenant isolation on the query path', async () => {
		const s = new InMemoryVectorStore()
		await s.upsert([
			chunk('a', { tenantId: T1, embedding: [1, 0, 0] }),
			chunk('b', { tenantId: T2, embedding: [1, 0, 0] }),
		])
		const results = await s.search({ ...baseQuery, tenantId: T1 })
		expect(results.map((r) => r.chunk.id)).toEqual(['a'])
	})

	it('filters by knowledgeBaseId when provided', async () => {
		const s = new InMemoryVectorStore()
		await s.upsert([chunk('a', { knowledgeBaseId: KB1 }), chunk('b', { knowledgeBaseId: KB2 })])
		const results = await s.search({ ...baseQuery, knowledgeBaseId: KB1 })
		expect(results.map((r) => r.chunk.id)).toEqual(['a'])
	})

	it('skips chunks with no embedding', async () => {
		const s = new InMemoryVectorStore()
		await s.upsert([chunk('a', { embedding: [1, 0, 0] }), chunk('b', { embedding: undefined })])
		const results = await s.search(baseQuery)
		expect(results.map((r) => r.chunk.id)).toEqual(['a'])
	})

	it('applies AND-of-equalities across filter keys', async () => {
		const s = new InMemoryVectorStore()
		await s.upsert([
			chunk('a', { metadata: { lang: 'en', year: 2026 } }),
			chunk('b', { metadata: { lang: 'en', year: 2024 } }),
			chunk('c', { metadata: { lang: 'tr', year: 2026 } }),
		])
		const results = await s.search({
			...baseQuery,
			filter: { lang: 'en', year: 2026 },
		})
		expect(results.map((r) => r.chunk.id)).toEqual(['a'])
	})

	it('applies minScore cutoff', async () => {
		const s = new InMemoryVectorStore()
		await s.upsert([
			chunk('same', { embedding: [1, 0, 0] }),
			chunk('orthogonal', { embedding: [0, 1, 0] }),
		])
		const results = await s.search({ ...baseQuery, minScore: 0.5 })
		expect(results.map((r) => r.chunk.id)).toEqual(['same'])
	})

	it('sorts descending by score and slices to topK', async () => {
		const s = new InMemoryVectorStore()
		await s.upsert([
			chunk('strong', { embedding: [1, 0, 0] }),
			chunk('medium', { embedding: [0.5, 0.5, 0] }),
			chunk('weak', { embedding: [0.1, 0.9, 0] }),
		])
		const results = await s.search({ ...baseQuery, topK: 2 })
		expect(results.map((r) => r.chunk.id)).toEqual(['strong', 'medium'])
	})
})

describe('InMemoryVectorStore — delete', () => {
	it('delete(chunkIds) removes each id; unknown ids are silent', async () => {
		const s = new InMemoryVectorStore()
		await s.upsert([chunk('a'), chunk('b')])
		await s.delete(['a' as ChunkId, 'missing' as ChunkId])
		expect((await s.search(baseQuery)).map((r) => r.chunk.id)).toEqual(['b'])
	})

	it('deleteByDocument removes every chunk of the document ACROSS tenants (asymmetry per Codex #9)', async () => {
		const s = new InMemoryVectorStore()
		await s.upsert([
			chunk('a', { documentId: D1, tenantId: T1 }),
			chunk('b', { documentId: D1, tenantId: T2 }),
			chunk('c', { documentId: D2, tenantId: T1 }),
		])
		await s.deleteByDocument(D1)
		// Both D1 chunks gone even though we didn't pass a tenant.
		expect((await s.search({ ...baseQuery, tenantId: T1 })).map((r) => r.chunk.id)).toEqual(['c'])
		expect(await s.search({ ...baseQuery, tenantId: T2 })).toEqual([])
	})

	it('deleteByKnowledgeBase is tenant-scoped', async () => {
		const s = new InMemoryVectorStore()
		await s.upsert([
			chunk('a', { knowledgeBaseId: KB1, tenantId: T1 }),
			chunk('b', { knowledgeBaseId: KB1, tenantId: T2 }),
		])
		await s.deleteByKnowledgeBase(KB1, T1)
		expect(await s.search({ ...baseQuery, tenantId: T1 })).toEqual([])
		expect((await s.search({ ...baseQuery, tenantId: T2 })).map((r) => r.chunk.id)).toEqual(['b'])
	})
})

describe('cosineSimilarity', () => {
	it('is 1 for identical non-zero vectors', () => {
		expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1)
	})

	it('is 0 for orthogonal vectors', () => {
		expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
	})

	it('is 0 when vectors differ in length', () => {
		expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0)
	})

	it('is 0 when either vector has zero norm', () => {
		expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
		expect(cosineSimilarity([1, 1], [0, 0])).toBe(0)
	})
})
