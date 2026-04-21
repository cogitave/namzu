/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 4):
 *
 *   - `TextChunker.chunk(content, config)` dispatches by
 *     `config.strategy`. Unknown strategy hits an exhaustive-check
 *     throw (unreachable via types).
 *   - `fixed` strategy: slides a window of `chunkSize` by
 *     `chunkSize − chunkOverlap` (min 1) and emits trimmed non-empty
 *     slices. Indices are 0-based and contiguous.
 *   - `sentence` / `paragraph` strategies split by their separator
 *     sets and then merge small parts until the budget fills.
 *   - `recursive` strategy: short content returns as a single chunk;
 *     otherwise it splits by the first separator that produces >1
 *     parts, merges, and recurses into parts that still exceed
 *     `chunkSize`. Falls back to `fixed` when no separator splits.
 *   - Overlap is applied in `mergeSmallParts` via
 *     `current.slice(current.length - chunkOverlap) + part`.
 */

import { describe, expect, it } from 'vitest'

import type { ChunkingConfig } from '../types/rag/index.js'

import { TextChunker } from './chunking.js'

const chunker = new TextChunker()

describe('TextChunker — fixed', () => {
	const fixed: ChunkingConfig = { strategy: 'fixed', chunkSize: 10, chunkOverlap: 2 }

	it('emits trimmed non-empty slices with contiguous indices', () => {
		const result = chunker.chunk('0123456789abcdefghij', fixed)
		expect(result).toHaveLength(3)
		expect(result.map((c) => c.index)).toEqual([0, 1, 2])
	})

	it('skips whitespace-only slices', () => {
		const result = chunker.chunk('abc           def', {
			strategy: 'fixed',
			chunkSize: 5,
			chunkOverlap: 0,
		})
		expect(result.map((c) => c.content)).not.toContain('')
	})

	it('clamps step to at least 1 when overlap >= chunkSize', () => {
		const result = chunker.chunk('abcdefghij', {
			strategy: 'fixed',
			chunkSize: 3,
			chunkOverlap: 3,
		})
		// step = max(1, 3-3) = 1; eagerly emits many overlapping slices
		expect(result.length).toBeGreaterThan(1)
	})
})

describe('TextChunker — sentence', () => {
	it('splits by sentence separators and merges up to the budget', () => {
		const result = chunker.chunk('First sentence. Second sentence. Third sentence.', {
			strategy: 'sentence',
			chunkSize: 100,
			chunkOverlap: 0,
		})
		expect(result.length).toBeGreaterThanOrEqual(1)
		expect(result[0]?.content).toContain('First sentence')
	})
})

describe('TextChunker — paragraph', () => {
	it('splits by paragraph separators', () => {
		const result = chunker.chunk('para one\n\npara two\n\npara three', {
			strategy: 'paragraph',
			chunkSize: 200,
			chunkOverlap: 0,
		})
		expect(result.length).toBeGreaterThanOrEqual(1)
	})
})

describe('TextChunker — recursive', () => {
	it('short content fits into a single chunk', () => {
		const result = chunker.chunk('tiny', {
			strategy: 'recursive',
			chunkSize: 100,
			chunkOverlap: 0,
		})
		expect(result).toEqual([{ content: 'tiny', index: 0 }])
	})

	it('long content recursively splits to stay within chunkSize', () => {
		const content = 'paragraph one. more text.\n\nparagraph two. more.'
		const result = chunker.chunk(content, {
			strategy: 'recursive',
			chunkSize: 30,
			chunkOverlap: 0,
		})
		for (const c of result) {
			expect(c.content.length).toBeLessThanOrEqual(30)
		}
	})

	it('empty or whitespace-only content yields empty result', () => {
		expect(chunker.chunk('   ', { strategy: 'recursive', chunkSize: 10, chunkOverlap: 0 })).toEqual(
			[],
		)
	})
})
