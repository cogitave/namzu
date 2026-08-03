import { describe, expect, it } from 'vitest'

import { TextChunker, splitKeepingSeparator } from '../chunking.js'

/**
 * Retrieval arithmetic, pinned by the counterexample that proves each
 * defect. Every test here fails against the previous formula.
 */

describe('splitKeepingSeparator', () => {
	it('does not delete the separator it split on', () => {
		// `'A. B. C.'.split('. ')` returns ['A','B','C.'] — the sentence
		// terminators are gone, so the retrieved chunk no longer says what
		// the document said.
		expect(splitKeepingSeparator('A. B. C.', '. ')).toEqual(['A. ', 'B. ', 'C.'])
	})

	it('reconstructs the input exactly', () => {
		const text = 'First para.\n\nSecond para.\n\nThird.'
		expect(splitKeepingSeparator(text, '\n\n').join('')).toBe(text)
	})

	it('handles a trailing separator without emitting an empty tail', () => {
		expect(splitKeepingSeparator('a\n\nb\n\n', '\n\n')).toEqual(['a\n\n', 'b\n\n'])
	})

	it('returns the whole text when the separator is absent', () => {
		expect(splitKeepingSeparator('no breaks here', '\n\n')).toEqual(['no breaks here'])
	})

	it('handles consecutive separators', () => {
		const text = 'a\n\n\n\nb'
		expect(splitKeepingSeparator(text, '\n\n').join('')).toBe(text)
	})
})

describe('TextChunker preserves the source text', () => {
	it('keeps sentence terminators in recursive chunks', () => {
		// The seam, not the helper: the chunker used `text.split(sep)`, so a
		// recursive split on '. ' returned chunks with the periods removed.
		const text = `${'Alpha beta gamma. '.repeat(20)}Delta epsilon zeta.`
		const chunks = new TextChunker().chunk(text, {
			strategy: 'recursive',
			chunkSize: 100,
			chunkOverlap: 0,
		})

		expect(chunks.length).toBeGreaterThan(1)
		// Every sentence in a chunk still ends the way the document did.
		const joined = chunks.map((c) => c.content).join(' ')
		expect(joined).toContain('Alpha beta gamma.')
		expect(joined).not.toContain('Alpha beta gamma Alpha')
	})
})
