import { describe, expect, it } from 'vitest'

import type { EmbeddingProvider, TenantScope } from '../../types/rag/index.js'
import { DefaultIngestionPipeline } from '../ingestion.js'
import { DefaultRetriever } from '../retriever.js'
import { InMemoryVectorStore } from '../vector-store.js'

/**
 * `TenantScope.namespace` and `KnowledgeBaseConfig.namespace` were declared
 * from the start and neither reached storage. Ingestion copied
 * `scope.tenantId` onto every chunk and dropped the namespace; the store
 * filtered on tenant alone. So a partition a host asked for did not exist,
 * and every namespace in a tenant saw every other one's documents.
 */

/** Deterministic and content-derived, so similarity is stable across runs. */
const embedder: EmbeddingProvider = {
	async embed(texts: string[]) {
		return texts.map((t) => [t.length % 7, t.charCodeAt(0) % 5, 1])
	},
	async embedQuery(text: string) {
		return [text.length % 7, text.charCodeAt(0) % 5, 1]
	},
	dimensions: 3,
	model: 'test-embedder',
	id: 'test-embedder',
}

const tenant = 'tnt_one' as TenantScope['tenantId']

function scope(namespace?: string): TenantScope {
	return { tenantId: tenant, ...(namespace !== undefined ? { namespace } : {}) }
}

async function seed() {
	const store = new InMemoryVectorStore()
	const ingestion = new DefaultIngestionPipeline(store, embedder)
	const kb = 'kb_one' as never

	await ingestion.ingest('alpha partition content', {}, scope('alpha'), kb)
	await ingestion.ingest('beta partition content', {}, scope('beta'), kb)
	await ingestion.ingest('default partition content', {}, scope(), kb)

	return { store, retriever: new DefaultRetriever(store, embedder), kb }
}

const texts = (r: { chunks: { chunk: { content: string } }[] }) =>
	r.chunks.map((c) => c.chunk.content)

describe('a namespace partitions what a query can see', () => {
	it('returns only its own partition', async () => {
		const { retriever, kb } = await seed()

		const found = await retriever.retrieve({ text: 'partition content' }, scope('alpha'), kb)

		expect(texts(found)).toEqual(['alpha partition content'])
	})

	it('does not leak the other partition', async () => {
		const { retriever, kb } = await seed()

		const found = await retriever.retrieve({ text: 'partition content' }, scope('beta'), kb)

		expect(texts(found).join()).not.toContain('alpha')
	})

	it('treats an absent namespace as the default partition, not as no filter', async () => {
		const { retriever, kb } = await seed()

		const found = await retriever.retrieve({ text: 'partition content' }, scope(), kb)

		// The whole point. Reading absence as "no filter" is how the boundary
		// leaks: a caller who never asked for a namespace would see every
		// namespaced chunk in the tenant.
		expect(texts(found)).toEqual(['default partition content'])
	})

	it('keeps tenants apart as it always did', async () => {
		const { retriever, kb } = await seed()

		const found = await retriever.retrieve(
			{ text: 'partition content' },
			{
				tenantId: 'tnt_other' as TenantScope['tenantId'],
				namespace: 'alpha',
			},
			kb,
		)

		expect(found.chunks).toEqual([])
	})

	it('stamps the namespace onto the chunk at ingest', async () => {
		const { store } = await seed()

		const results = await store.search({
			embedding: await embedder.embedQuery('partition content'),
			topK: 10,
			tenantId: tenant,
			namespace: 'alpha',
		})

		// Ingest is where it has to land — filtering at search against a value
		// nothing writes returns zero rows, and "no results" reads as "nothing
		// matched" rather than "this scope was never stored".
		expect(results.every((r) => r.chunk.content.startsWith('alpha'))).toBe(true)
		expect(results.length).toBeGreaterThan(0)
	})
})
