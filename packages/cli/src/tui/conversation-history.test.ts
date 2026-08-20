import {
	createAssistantMessage,
	createProjectInstructionMessage,
	createSystemMessage,
	createToolMessage,
	createUserMessage,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { planTurnPublication, projectRunConversation } from './conversation-history.js'

describe('a settled Run is projected back into host conversation coordinates', () => {
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
			projectRunConversation([
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
			projectRunConversation([
				createSystemMessage('fresh identity and environment floor'),
				policy,
				human,
				assistant,
			]),
		).toEqual([policy, human, assistant])
	})
})

describe('a projected turn is published without structural tears', () => {
	it('appends an exact plain assistant turn, including opaque reasoning', () => {
		const prior = [createUserMessage('old'), createAssistantMessage('old answer')]
		const user = createUserMessage('new')
		const assistant = createAssistantMessage('new answer', undefined, [
			{ type: 'redacted_thinking', encrypted: 'ciphertext' },
		])

		expect(planTurnPublication(prior, user, [...prior, user, assistant])).toEqual({
			kind: 'append',
			messages: [user, assistant],
		})
	})

	it('atomically replaces a complete tool sequence', () => {
		const prior = [createUserMessage('old')]
		const user = createUserMessage('inspect')
		const call = createAssistantMessage(null, [
			{
				id: 'call_1',
				type: 'function',
				function: { name: 'read', arguments: '{}' },
			},
		])
		const result = createToolMessage('contents', 'call_1')
		const answer = createAssistantMessage('done')
		const projected = [...prior, user, call, result, answer]

		expect(planTurnPublication(prior, user, projected)).toEqual({
			kind: 'replace',
			messages: projected,
		})
	})

	it('replaces when in-run compaction changed the prior prefix', () => {
		const prior = [createUserMessage('old fact'), createAssistantMessage('old answer')]
		const user = createUserMessage('new')
		const projected = [
			{
				...createSystemMessage(
					'[COMPACTED CONTEXT] The following is a structured summary of the conversation so far.\n\nold fact',
				),
				retain: true,
			},
			user,
			createAssistantMessage('new answer'),
		]

		expect(planTurnPublication(prior, user, projected)).toEqual({
			kind: 'replace',
			messages: projected,
		})
	})

	it('atomically publishes an injected project snapshot with its human turn', () => {
		const prior = [createUserMessage('old'), createAssistantMessage('old answer')]
		const policy = createProjectInstructionMessage('current policy', ['AGENTS.md'])
		const user = createUserMessage('new')
		const assistant = createAssistantMessage('new answer')
		const projected = [...prior, policy, user, assistant]

		expect(planTurnPublication(prior, user, projected)).toEqual({
			kind: 'replace',
			messages: projected,
		})
	})
})
