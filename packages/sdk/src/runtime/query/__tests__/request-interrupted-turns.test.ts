import { describe, expect, it } from 'vitest'

import { createRuntimeContextMessage } from '../../../types/message/index.js'
import type { Message } from '../../../types/message/index.js'
import {
	INTERRUPTED_REQUEST_MARKER,
	withInterruptedRequestsMarked,
} from '../request-interrupted-turns.js'
import { withoutVoidAssistantTurns } from '../request-void-turns.js'

const context = createRuntimeContextMessage('Recorded context: repository', 'turn-context')

describe('withInterruptedRequestsMarked', () => {
	it('returns the same array when every request was answered', () => {
		const messages: Message[] = [
			{ role: 'user', content: 'a' },
			{ role: 'assistant', content: 'A' },
			{ role: 'user', content: 'b' },
		]
		expect(withInterruptedRequestsMarked(messages)).toBe(messages)
	})

	it('marks an unanswered request right behind it, past any context that follows', () => {
		const messages: Message[] = [
			{ role: 'user', content: 'a' },
			{ role: 'assistant', content: 'A' },
			{ role: 'user', content: 'essay' },
			context,
			{ role: 'user', content: 'list' },
		]
		const view = withInterruptedRequestsMarked(messages)
		expect(view.map((m) => (typeof m.content === 'string' ? m.content : ''))).toEqual([
			'a',
			'A',
			'essay',
			INTERRUPTED_REQUEST_MARKER,
			'Recorded context: repository',
			'list',
		])
		expect(messages).toHaveLength(5)
	})

	it('gives the same view for the same history, as a resume does', () => {
		const messages: Message[] = [
			{ role: 'user', content: 'x' },
			{ role: 'user', content: 'y' },
			{ role: 'user', content: 'z' },
		]
		const a = withInterruptedRequestsMarked(messages)
		const b = withInterruptedRequestsMarked([...messages])
		expect(a.map((m) => m.content)).toEqual([
			'x',
			INTERRUPTED_REQUEST_MARKER,
			'y',
			INTERRUPTED_REQUEST_MARKER,
			'z',
		])
		expect(b.map((m) => m.content)).toEqual(a.map((m) => m.content))
	})

	it('sees through the empty reply an interrupted turn leaves behind', () => {
		const messages: Message[] = [
			{ role: 'user', content: 'essay' },
			{ role: 'assistant', content: '' },
			{ role: 'user', content: 'ready' },
		]
		const view = withInterruptedRequestsMarked(withoutVoidAssistantTurns(messages))
		expect(view.map((m) => m.content)).toEqual(['essay', INTERRUPTED_REQUEST_MARKER, 'ready'])
	})
})
