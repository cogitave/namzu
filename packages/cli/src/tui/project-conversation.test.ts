import {
	createAssistantMessage,
	createProjectInstructionMessage,
	createRuntimeContextMessage,
	createToolMessage,
	createUserMessage,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { projectConversation } from './App.js'

describe('conversation projection', () => {
	it('omits empty tool-only assistant rows without modifying their model history', () => {
		const call = createAssistantMessage(null, [
			{ id: 'call', type: 'function', function: { name: 'read', arguments: '{}' } },
		])
		const messages = [
			createUserMessage('inspect'),
			call,
			createToolMessage('exact tool result', 'call'),
			createAssistantMessage(' \n\t'),
			createAssistantMessage('  Done.\n'),
		]
		const original = structuredClone(messages)
		let id = 0
		expect(projectConversation(messages, () => String(++id))).toEqual([
			{ id: '1', role: 'user', content: 'inspect' },
			{ id: '2', role: 'assistant', content: '  Done.\n' },
		])
		expect(messages).toEqual(original)
	})
	it('restores public item boundaries while retaining intentional repeated final text', () => {
		const answer = createAssistantMessage('ha ha\n\nha ha')
		answer.textParts = [
			{ id: 'progress', phase: 'commentary', text: 'Working on it.' },
			{ id: 'a', phase: 'final_answer', text: 'ha ha' },
			{ id: 'b', phase: 'final_answer', text: 'ha ha' },
		]
		const rows = projectConversation([answer], () => 'row')
		expect(rows.map((row) => row.content)).toEqual(['Working on it.', 'ha ha', 'ha ha'])
	})
	it.each(['changed answer', ''])(
		'does not restore superseded parts when content is %j',
		(content) => {
			const answer = createAssistantMessage(content)
			answer.textParts = [{ id: 'old', phase: 'final_answer', text: 'OLD ANSWER' }]
			expect(projectConversation([answer], () => 'row').map((row) => row.content)).toEqual(
				content ? [content] : [],
			)
		},
	)
	it.each([
		null,
		{},
		[null],
		[{ id: 'bad', text: 17 }],
		[{ id: 'bad', text: 'HIDDEN', phase: 'private' }],
	])('uses current public content for malformed optional parts %j', (parts) => {
		const answer = {
			...createAssistantMessage('Current text'),
			textParts: parts,
		} as unknown as ReturnType<typeof createAssistantMessage>
		expect(projectConversation([answer], () => 'row').map((row) => row.content)).toEqual([
			'Current text',
		])
	})
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
