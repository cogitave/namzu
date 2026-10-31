import { describe, expect, it } from 'vitest'

import {
	COMPACTED_HINT,
	COMPACTED_TEXT,
	COMPACTING_LABEL,
	COMPACT_RESULT_HINT,
	compactResultLine,
	compactionHistoryLines,
	compactionSummaryLines,
	describeCompactionFailure,
	estimateHistoryTokens,
	stripCompactionMarker,
} from './compaction-rows.js'

describe('compaction wording', () => {
	it('uses the short compaction words', () => {
		expect(COMPACTING_LABEL).toBe('Compacting conversation…')
		expect(COMPACTED_TEXT).toBe('Conversation compacted')
		expect(COMPACTED_HINT).toBe('(ctrl+o for history)')
		expect(COMPACT_RESULT_HINT).toBe('(ctrl+o to see full summary)')
	})

	it('puts the counts behind ctrl+o in plain words', () => {
		expect(
			compactionHistoryLines({
				messagesBefore: 24,
				messagesAfter: 3,
				tokensBefore: 180_000,
				tokensAfter: 12_000,
				measuredBy: 'estimate',
			}),
		).toEqual([
			'24 messages became 3 messages.',
			'Context went from about 180k to about 12k tokens.',
		])
	})
})

describe('the displayed summary', () => {
	const marker =
		'[COMPACTED CONTEXT] The following is a structured summary of the conversation so far.'

	it('drops the marker the model reads', () => {
		expect(stripCompactionMarker(`${marker}\n\n## Task\nfix it`)).toBe('## Task\nfix it')
		expect(compactionSummaryLines(`${marker}\n\n## Task\nfix it`)).toEqual(['## Task', 'fix it'])
	})

	it('says so when the summary is empty', () => {
		expect(compactionSummaryLines(marker)).toEqual(['(the summary was empty)'])
	})
})

describe('describeCompactionFailure', () => {
	it('is one plain sentence with no reducer in it', () => {
		for (const cause of [
			'reducer_threw',
			'shed_nothing',
			'split_tool_pair',
			'refilling',
		] as const) {
			const text = describeCompactionFailure({ cause, error: 'boom: ECONNRESET' }, false)
			expect(text).not.toMatch(/reducer|bug/i)
			expect(text).not.toContain('ECONNRESET')
		}
		expect(describeCompactionFailure({ cause: 'shed_nothing' }, false)).toContain(
			'Compaction failed · conversation could not be reduced below the context limit',
		)
	})

	it('keeps the raw error behind debug detail', () => {
		expect(
			describeCompactionFailure({ cause: 'reducer_threw', error: 'boom: ECONNRESET' }, true),
		).toContain('boom: ECONNRESET')
	})
})

describe('the /compact result line', () => {
	it('says how many messages were summarised and the size before and after', () => {
		expect(compactResultLine({ shed: 12, tokensBefore: 190_400, tokensAfter: 20_100 })).toBe(
			'Compacted · 12 messages summarized · context about 190k to 20k tokens',
		)
	})

	it('says one message in the singular and small sizes as plain numbers', () => {
		expect(compactResultLine({ shed: 1, tokensBefore: 900, tokensAfter: 300 })).toBe(
			'Compacted · 1 message summarized · context about 900 to 300 tokens',
		)
	})

	it('leaves the sizes out when nothing got smaller', () => {
		expect(compactResultLine({ shed: 3, tokensBefore: 500, tokensAfter: 500 })).toBe(
			'Compacted · 3 messages summarized',
		)
	})

	it('keeps a tenth of a thousand under 10k so two sizes do not read the same', () => {
		expect(compactResultLine({ shed: 3, tokensBefore: 2_400, tokensAfter: 1_600 })).toBe(
			'Compacted · 3 messages summarized · context about 2.4k to 1.6k tokens',
		)
	})

	it('leaves the sizes out when both read the same', () => {
		expect(compactResultLine({ shed: 3, tokensBefore: 2_040, tokensAfter: 1_960 })).toBe(
			'Compacted · 3 messages summarized',
		)
	})

	it('estimates a conversation from its text, four characters to a token', () => {
		expect(
			estimateHistoryTokens([
				{ role: 'user', content: 'a'.repeat(40) },
				{ role: 'assistant', content: [{ type: 'text', text: 'b'.repeat(40) }] },
			] as never),
		).toBe(20)
	})
})
