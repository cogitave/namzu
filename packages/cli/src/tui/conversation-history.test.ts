import {
	createAssistantMessage,
	createProjectInstructionMessage,
	createSystemMessage,
	createUserMessage,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { projectTurnConversation } from './conversation-history.js'

describe('a settled turn is projected back into host conversation coordinates', () => {
	it('drops fresh system floor while retaining conversation compaction state', () => {
		const summary = {
			...createSystemMessage(
				'[COMPACTED CONTEXT] The following is a structured summary of the conversation so far.\n\nkeep this',
			),
			retain: true,
		}
		const user = createUserMessage('hello')
		const assistant = createAssistantMessage('answer', undefined, [
			{ type: 'thinking', text: 'opaque thought', signature: 'signed-exactly' },
		])

		expect(
			projectTurnConversation([
				createSystemMessage('NAMZU IDENTITY + STATIC PROJECT RULES', 'cache'),
				createSystemMessage('DYNAMIC ENVIRONMENT + ACTIVE SKILL', 'ephemeral'),
				summary,
				user,
				assistant,
			]),
		).toEqual([summary, user, assistant])
	})

	it('keeps a retained project snapshot in durable conversation coordinates', () => {
		const policy = createProjectInstructionMessage('nested policy', [
			'AGENTS.md',
			'packages/a/AGENTS.md',
		])
		const human = createUserMessage('continue')
		const assistant = createAssistantMessage('done')

		expect(
			projectTurnConversation([
				createSystemMessage('fresh identity and environment floor'),
				policy,
				human,
				assistant,
			]),
		).toEqual([policy, human, assistant])
	})
})
