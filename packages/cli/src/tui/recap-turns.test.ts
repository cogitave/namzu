import { describe, expect, it } from 'vitest'

import { recapRows, recapTurns } from './recap-turns.js'
import type { TranscriptMessage } from './types.js'

const row = (
	id: string,
	role: TranscriptMessage['role'],
	content: string,
	extra: Partial<TranscriptMessage> = {},
): TranscriptMessage => ({ id, role, content, ...extra })

const MESSAGES: readonly TranscriptMessage[] = [
	row('1', 'user', 'fix the build'),
	row('2', 'tool', 'ran npm test'),
	row('3', 'system', 'a notice'),
	row('4', 'assistant', 'Done.'),
	row('5', 'user', 'from a schedule', { sourceDelivery: true }),
	row('6', 'assistant', 'streaming…', { pending: true }),
	row('7', 'system', 'Where things stand.', { kind: 'recap' }),
	row('8', 'user', 'now the docs'),
]

describe('what the recap counts', () => {
	it('counts typed prompts, finished replies and recaps, and nothing else', () => {
		expect(recapRows(MESSAGES)).toEqual(['prompt', 'reply', 'recap', 'prompt'])
	})

	it('digests prompts and replies only, never a recap or tool output', () => {
		expect(recapTurns(MESSAGES)).toEqual([
			{ role: 'user', text: 'fix the build' },
			{ role: 'assistant', text: 'Done.' },
			{ role: 'user', text: 'now the docs' },
		])
	})
})
