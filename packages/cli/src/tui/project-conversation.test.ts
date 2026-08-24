import {
	createAssistantMessage,
	createProjectInstructionMessage,
	createRuntimeContextMessage,
	createUserMessage,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { projectConversation } from './App.js'

describe('conversation projection', () => {
	it('shows project policy as context without consuming a human display text', () => {
		let id = 0
		const nextId = () => {
			id += 1
			return `row_${id}`
		}
		const rows = projectConversation(
			[
				createProjectInstructionMessage('hidden policy body', [
					'AGENTS.md',
					'packages/a/AGENTS.md',
					'packages/\u202e/AGENTS.md',
				]),
				createUserMessage('expanded user text'),
				createAssistantMessage('done'),
			],
			nextId,
			['readable @file text'],
		)

		expect(rows).toEqual([
			{
				id: 'row_1',
				role: 'system',
				content: 'Project instructions',
				glyph: '◇',
				detail: [
					'In force: AGENTS.md',
					'In force: packages/a/AGENTS.md',
					'In force: packages/\\u202e/AGENTS.md',
				],
			},
			{ id: 'row_2', role: 'user', content: 'readable @file text' },
			{ id: 'row_3', role: 'assistant', content: 'done' },
		])
	})

	it('shows runtime-authored user-role context without consuming human display text', () => {
		let id = 0
		const runtime = createRuntimeContextMessage('retry with the required tool', 'structured-output')
		const human = createUserMessage('expanded human text')

		const rows = projectConversation(
			[runtime, human, createAssistantMessage('done')],
			() => `row_${++id}`,
			['human @file text'],
		)

		expect(rows).toEqual([
			{
				id: 'row_1',
				role: 'system',
				content: 'Structured-output retry',
				glyph: '↳',
				detail: ['retry with the required tool'],
			},
			{ id: 'row_2', role: 'user', content: 'human @file text' },
			{ id: 'row_3', role: 'assistant', content: 'done' },
		])
	})
})
