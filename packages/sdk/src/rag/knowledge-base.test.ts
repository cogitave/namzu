/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 4):
 *
 *   - `DefaultKnowledgeBase` is a composition layer: it builds an
 *     ingestion pipeline + a retriever from its config and delegates
 *     `ingest` / `query` / `remove` / `clear` to them.
 *   - `id` is set from `config.id` if provided, else generated once
 *     via `generateKnowledgeBaseId` — never regenerated later.
 *   - `ingest(content, metadata)` invokes the ingestion pipeline with
 *     the configured scope + kb id; returns whatever the pipeline
 *     returns.
 *   - `query(query)` invokes the retriever with scope + kb id.
 *   - `clear()` calls `vectorStore.deleteByKnowledgeBase(id, tenantId)`.
 *   - `remove(documentId)` calls `vectorStore.deleteByDocument`.
 */

import { describe, expect, it, vi } from 'vitest'

import type { DocumentId, KnowledgeBaseId, TenantId } from '../types/ids/index.js'
import type { EmbeddingProvider, VectorStore } from '../types/rag/index.js'

import { DefaultKnowledgeBase } from './knowledge-base.js'

const TENANT = 't_1' as TenantId

function makeVectorStore(): VectorStore {
	return {
		upsert: vi.fn(),
		search: vi.fn(async () => []),
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

describe('DefaultKnowledgeBase', () => {
	it('uses the id provided in config when set', () => {
		const kb = new DefaultKnowledgeBase(
			{ id: 'kb_fixed' as KnowledgeBaseId, name: 'kb', tenantId: TENANT },
			makeVectorStore(),
			makeEmbedder(),
		)
		expect(kb.id).toBe('kb_fixed')
		expect(kb.config.id).toBe('kb_fixed')
	})

	it('generates an id when none is provided', () => {
		const kb = new DefaultKnowledgeBase(
			{ name: 'kb', tenantId: TENANT },
			makeVectorStore(),
			makeEmbedder(),
		)
		expect(kb.id).toMatch(/^kb_/)
	})

	it('ingest delegates to the ingestion pipeline and carries metadata through', async () => {
		const vs = makeVectorStore()
		const kb = new DefaultKnowledgeBase(
			{ id: 'kb_fixed' as KnowledgeBaseId, name: 'kb', tenantId: TENANT },
			vs,
			makeEmbedder(),
		)
		const result = await kb.ingest('hello world', { source: 'readme' })
		expect(result.documentId).toMatch(/^doc_/)
		expect(vs.upsert).toHaveBeenCalled()
		const chunks = vi.mocked(vs.upsert).mock.calls[0]?.[0] ?? []
		expect(chunks[0]?.knowledgeBaseId).toBe('kb_fixed')
		expect(chunks[0]?.tenantId).toBe(TENANT)
	})

	it('remove delegates to vectorStore.deleteByDocument', async () => {
		const vs = makeVectorStore()
		const kb = new DefaultKnowledgeBase({ name: 'kb', tenantId: TENANT }, vs, makeEmbedder())
		await kb.remove('doc_1' as DocumentId)
		expect(vs.deleteByDocument).toHaveBeenCalledWith('doc_1')
	})

	it('clear delegates to vectorStore.deleteByKnowledgeBase with id + tenantId', async () => {
		const vs = makeVectorStore()
		const kb = new DefaultKnowledgeBase(
			{ id: 'kb_fixed' as KnowledgeBaseId, name: 'kb', tenantId: TENANT },
			vs,
			makeEmbedder(),
		)
		await kb.clear()
		expect(vs.deleteByKnowledgeBase).toHaveBeenCalledWith('kb_fixed', TENANT)
	})

	it('query delegates to retriever', async () => {
		const vs = makeVectorStore()
		const kb = new DefaultKnowledgeBase({ name: 'kb', tenantId: TENANT }, vs, makeEmbedder())
		const out = await kb.query({ text: 'hi' })
		expect(out.mode).toBeDefined()
		expect(vs.search).toHaveBeenCalled()
	})
})
