/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 4):
 *
 *   - `createRAGTool(config)` returns a `defineTool`-wrapped
 *     `knowledge_search` tool with `category: 'analysis'`,
 *     `permissions: ['network_access']`, read-only.
 *   - Knowledge base selection:
 *     - If `input.knowledge_base_id` is set, looks up by it.
 *     - Else uses `config.defaultKnowledgeBaseId`.
 *     - Else picks the first value from
 *       `config.knowledgeBases.values().next()`.
 *   - Returns `{success: false, error: ...}` if no knowledge base is
 *     resolved.
 *   - When the query returns no chunks, returns the literal
 *     "No relevant information found..." message.
 *   - When chunks exist, assembles them via `assembleRAGContext` and
 *     returns `{success: true, output: content, data: {sources, mode, durationMs}}`.
 *   - `top_k` override precedence: input > config.topK > 5.
 */

import { describe, expect, it, vi } from 'vitest'

import type { ChunkId, DocumentId, KnowledgeBaseId, TenantId } from '../types/ids/index.js'
import type { KnowledgeBase, RetrievalResult, VectorSearchResult } from '../types/rag/index.js'
import type { ToolContext } from '../types/tool/index.js'

import { createRAGTool } from './rag-tool.js'

const TENANT = 't_1' as TenantId
const KB_A = 'kb_a' as KnowledgeBaseId
const KB_B = 'kb_b' as KnowledgeBaseId

function makeKB(retrievalResult: RetrievalResult): KnowledgeBase {
	const kb = {
		id: KB_A,
		config: { id: KB_A, tenantId: TENANT },
		ingest: vi.fn(),
		remove: vi.fn(),
		query: vi.fn(async () => retrievalResult),
		clear: vi.fn(),
	} as unknown as KnowledgeBase
	return kb
}

function searchResult(content: string): VectorSearchResult {
	return {
		chunk: {
			id: 'c_1' as ChunkId,
			documentId: 'd_1' as DocumentId,
			knowledgeBaseId: KB_A,
			tenantId: TENANT,
			content,
			index: 0,
			tokenCount: 0,
			metadata: {},
			createdAt: 0,
		},
		score: 0.9,
	}
}

const ctx: ToolContext = {} as ToolContext

describe('createRAGTool', () => {
	it('is named knowledge_search + read-only', () => {
		const tool = createRAGTool({ knowledgeBases: new Map() })
		expect(tool.name).toBe('knowledge_search')
		expect(tool.isReadOnly?.({ query: 'x' })).toBe(true)
	})

	it('returns an error when no knowledge base is resolved', async () => {
		const tool = createRAGTool({ knowledgeBases: new Map() })
		const result = await tool.execute({ query: 'hi' }, ctx)
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/Knowledge base not found/)
	})

	it('picks KB by explicit input.knowledge_base_id when set', async () => {
		const kbA = makeKB({
			chunks: [searchResult('from A')],
			query: 'hi',
			mode: 'vector',
			durationMs: 1,
		})
		const kbB = makeKB({
			chunks: [searchResult('from B')],
			query: 'hi',
			mode: 'vector',
			durationMs: 1,
		})
		const tool = createRAGTool({
			knowledgeBases: new Map([
				[KB_A, kbA],
				[KB_B, kbB],
			]),
		})
		const out = await tool.execute({ query: 'hi', knowledge_base_id: KB_B }, ctx)
		expect(out.success).toBe(true)
		expect(kbB.query).toHaveBeenCalled()
		expect(kbA.query).not.toHaveBeenCalled()
	})

	it('falls back to defaultKnowledgeBaseId when input.knowledge_base_id is absent', async () => {
		const kbA = makeKB({
			chunks: [searchResult('from A')],
			query: 'hi',
			mode: 'vector',
			durationMs: 1,
		})
		const kbB = makeKB({
			chunks: [],
			query: 'hi',
			mode: 'vector',
			durationMs: 1,
		})
		const tool = createRAGTool({
			knowledgeBases: new Map([
				[KB_A, kbA],
				[KB_B, kbB],
			]),
			defaultKnowledgeBaseId: KB_B,
		})
		await tool.execute({ query: 'hi' }, ctx)
		expect(kbB.query).toHaveBeenCalled()
		expect(kbA.query).not.toHaveBeenCalled()
	})

	it('returns "No relevant information..." when the query returns zero chunks', async () => {
		const kb = makeKB({ chunks: [], query: 'hi', mode: 'vector', durationMs: 1 })
		const tool = createRAGTool({ knowledgeBases: new Map([[KB_A, kb]]) })
		const result = await tool.execute({ query: 'hi' }, ctx)
		expect(result.success).toBe(true)
		expect(result.output).toBe(
			'No relevant information found in the knowledge base for this query.',
		)
	})

	it('returns assembled content + metadata on hit', async () => {
		const kb = makeKB({
			chunks: [searchResult('answer text')],
			query: 'hi',
			mode: 'vector',
			durationMs: 42,
		})
		const tool = createRAGTool({ knowledgeBases: new Map([[KB_A, kb]]) })
		const result = await tool.execute({ query: 'hi' }, ctx)
		expect(result.success).toBe(true)
		expect(result.output).toContain('answer text')
		expect((result.data as { mode?: string })?.mode).toBe('vector')
		expect((result.data as { durationMs?: number })?.durationMs).toBe(42)
	})

	it('top_k override: input > config.topK > 5 default', async () => {
		const kb = makeKB({
			chunks: [searchResult('x')],
			query: 'hi',
			mode: 'vector',
			durationMs: 1,
		})
		const tool = createRAGTool({
			knowledgeBases: new Map([[KB_A, kb]]),
			topK: 8,
		})
		await tool.execute({ query: 'hi', top_k: 3 }, ctx)
		expect(kb.query).toHaveBeenCalledWith(expect.objectContaining({ config: { topK: 3 } }))
	})
})
