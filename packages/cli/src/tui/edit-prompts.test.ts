import {
	asGoalId,
	createAssistantMessage,
	createProjectInstructionMessage,
	createUserMessage,
} from '@namzu/sdk'
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

	it('excludes automatic goal prompts while preserving their durable user ordinal', () => {
		const automatic = createUserMessage('internal continuation', undefined, {
			type: 'goal-round',
			goalId: asGoalId('goal_edit_projection'),
			objective: 'finish',
			goalRevision: 2,
			round: 1,
			maxGoalRounds: 8,
		})
		const human = createUserMessage('human correction')

		const prompts = editablePrompts(
			[automatic, createAssistantMessage('progress'), human],
			[row('human', 'human correction')],
		)

		expect(prompts).toHaveLength(1)
		expect(prompts[0]).toMatchObject({ userOrdinal: 1, message: human })
	})

	it('does not offer a retained project-policy snapshot as editable human input', () => {
		const policy = createProjectInstructionMessage('standing policy', ['AGENTS.md'])
		const human = createUserMessage('human request')

		const prompts = editablePrompts(
			[policy, createAssistantMessage('context acknowledged'), human],
			[row('human', 'human request')],
		)

		expect(prompts).toHaveLength(1)
		expect(prompts[0]).toMatchObject({ userOrdinal: 1, message: human })
	})
})
