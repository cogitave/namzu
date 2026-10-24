import { describe, expect, it } from 'vitest'

import {
	COMPACTED_HINT,
	COMPACTED_TEXT,
	COMPACTING_LABEL,
	COMPACT_RESULT_HINT,
	compactionHistoryLines,
	compactionSummaryLines,
	describeCompactionFailure,
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
