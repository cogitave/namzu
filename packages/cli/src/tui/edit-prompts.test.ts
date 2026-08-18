import { createAssistantMessage, createUserMessage } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { editablePrompts } from './edit-prompts.js'
import type { TranscriptMessage } from './types.js'

const row = (id: string, content: string): TranscriptMessage => ({
	id,
	role: 'user',
	content,
})

describe('editable prompt projection', () => {
	it('uses readable transcript text but keeps the exact durable message and attachments', () => {
		const durable = createUserMessage('expanded contents of /workspace/design.md', [
			{ data: 'aGVsbG8=', mediaType: 'image/png' },
		])

		const [prompt] = editablePrompts([durable], [row('u1', 'review @design.md')])

		expect(prompt?.displayText).toBe('review @design.md')
		expect(prompt?.message).toBe(durable)
		expect(prompt?.message.attachments).toEqual(durable.attachments)
	})

	it('pairs from the newest end after clear-screen removes visible history', () => {
		const old = createUserMessage('old expanded prompt')
		const recent = createUserMessage('recent expanded prompt')
		const prompts = editablePrompts(
			[old, createAssistantMessage('old answer'), recent],
			[row('recent', 'recent @file prompt')],
		)

		expect(prompts.map((prompt) => prompt.displayText)).toEqual([
			'old expanded prompt',
			'recent @file prompt',
		])
		expect(prompts.map((prompt) => prompt.userOrdinal)).toEqual([0, 1])
	})
})
