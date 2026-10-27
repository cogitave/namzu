import {
	createAssistantMessage,
	createRuntimeContextMessage,
	createTurnContextEntry,
	createUserMessage,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { frameReminder } from '../../reminders/frame.js'
import { isModelOnlyContext } from '../runtime-message.js'

/**
 * Reminders (the task-list nudge among them) and recorded turn context are
 * written for the model. No surface the person reads may treat them as a
 * message: the transcript, exports and host history views all ask this one
 * question.
 */
describe('context written for the model alone', () => {
	it('covers a hidden reminder and a recorded turn-context entry', () => {
		const nudge = createRuntimeContextMessage(
			frameReminder('task-nudge', 'Track the work.'),
			'reminder',
		)
		expect(isModelOnlyContext(nudge)).toBe(true)
		expect(isModelOnlyContext(createTurnContextEntry('repository', 'branch state'))).toBe(true)
	})

	it('leaves the person’s messages and visible runtime notices alone', () => {
		expect(isModelOnlyContext(createUserMessage('hello'))).toBe(false)
		expect(isModelOnlyContext(createAssistantMessage('hi'))).toBe(false)
		expect(
			isModelOnlyContext(createRuntimeContextMessage('A task finished.', 'task-completion')),
		).toBe(false)
		expect(isModelOnlyContext(createRuntimeContextMessage('Keep going.', 'steering'))).toBe(false)
	})
})
