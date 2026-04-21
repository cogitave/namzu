/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 4):
 *
 *   - `assembleRAGContext([], cfg)` returns `{content: '', sources: [],
 *     tokenCount: 0}` immediately.
 *   - Token estimation: `Math.ceil(text.length / 4)`.
 *   - `headerTemplate` is prepended before any chunks.
 *   - Chunks are included in order while their accumulated token count
 *     stays below `maxTokens`; the first chunk that would overflow is
 *     dropped along with every subsequent chunk (early break).
 *   - `includeMetadata: true` prefixes each chunk with a bracketed
 *     metadata line (`Source: …`, `Title: …`, `Relevance: XX.X%`).
 *   - `sources[]` captures a truncated preview (first 200 chars) of
 *     each INCLUDED chunk; skipped chunks are NOT present.
 *   - `content` is the joined parts with `config.separator`;
 *     `tokenCount` is re-estimated from the joined content.
 */

import { describe, expect, it } from 'vitest'

import type { ChunkId, DocumentId, KnowledgeBaseId, TenantId } from '../types/ids/index.js'
import type { VectorSearchResult } from '../types/rag/index.js'

import { assembleRAGContext } from './context-assembler.js'

function result(
	content: string,
	score = 0.9,
	meta: Record<string, unknown> = {},
): VectorSearchResult {
	return {
		chunk: {
			id: `c_${content.slice(0, 3)}` as ChunkId,
			documentId: 'doc_1' as DocumentId,
			knowledgeBaseId: 'kb_1' as KnowledgeBaseId,
			tenantId: 't_1' as TenantId,
			content,
			index: 0,
			tokenCount: 0,
			metadata: meta,
			createdAt: 0,
		},
		score,
	}
}

describe('assembleRAGContext', () => {
	it('returns empty for empty input', () => {
		expect(assembleRAGContext([])).toEqual({ content: '', sources: [], tokenCount: 0 })
	})

	it('joins non-empty chunks with the configured separator', () => {
		const ctx = assembleRAGContext([result('alpha'), result('beta')], {
			separator: ' | ',
			maxTokens: 1000,
			includeMetadata: false,
			headerTemplate: undefined,
		})
		expect(ctx.content).toBe('alpha | beta')
	})

	it('includes a headerTemplate before chunks when provided', () => {
		const ctx = assembleRAGContext([result('body')], {
			separator: '\n',
			maxTokens: 1000,
			includeMetadata: false,
			headerTemplate: '### Knowledge',
		})
		expect(ctx.content.startsWith('### Knowledge\n')).toBe(true)
	})

	it('early-breaks once a chunk would overflow maxTokens (and drops subsequent)', () => {
		const long = 'a'.repeat(200) // ~50 tokens per the /4 estimate
		const ctx = assembleRAGContext([result('tiny'), result(long), result('also-tiny')], {
			separator: '\n',
			maxTokens: 20,
			includeMetadata: false,
			headerTemplate: undefined,
		})
		expect(ctx.content).toBe('tiny')
		// third chunk was NOT included even though it would fit — the loop breaks on first overflow.
		expect(ctx.sources.map((s) => s.chunk.slice(0, 10))).toEqual(['tiny'])
	})

	it('includeMetadata prefixes entries with bracketed metadata', () => {
		const ctx = assembleRAGContext([result('body', 0.7567, { source: 'repo', title: 'README' })], {
			separator: '\n',
			maxTokens: 1000,
			includeMetadata: true,
		})
		expect(ctx.content).toContain('[Source: repo | Title: README | Relevance: 75.7%]')
	})

	it('sources[] carries the first 200 chars of each included chunk', () => {
		const long = 'x'.repeat(500)
		const ctx = assembleRAGContext([result(long)], {
			separator: '\n',
			maxTokens: 10000,
			includeMetadata: false,
		})
		expect(ctx.sources[0]?.chunk).toHaveLength(200)
	})

	it('tokenCount is derived from the final joined content', () => {
		const ctx = assembleRAGContext([result('abcd'), result('efgh')], {
			separator: '',
			maxTokens: 1000,
			includeMetadata: false,
			headerTemplate: undefined,
		})
		// 'abcdefgh' → Math.ceil(8 / 4) = 2
		expect(ctx.tokenCount).toBe(2)
	})
})
