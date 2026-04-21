import { describe, expect, it } from 'vitest'
import type { ToolCallId } from '../../../../types/ids/index.js'
import type { AssistantMessage, Message, ToolMessage } from '../../../../types/message/index.js'
import { type Mutation, MutationNotApplicableError } from '../../../../types/run/replay.js'
import { applyMutations } from '../mutate.js'

function assistantWithCalls(toolCallIds: string[]): AssistantMessage {
	return {
		role: 'assistant',
		content: null,
		toolCalls: toolCallIds.map((id) => ({
			id,
			type: 'function',
			function: { name: 'noop', arguments: '{}' },
		})),
	}
}

describe('applyMutations / injectToolResponse', () => {
	it('appends a ToolMessage when the toolCallId is pending', () => {
		const messages: Message[] = [
			{ role: 'user', content: 'do stuff' },
			assistantWithCalls(['call_a', 'call_b']),
			{ role: 'tool', content: 'a done', toolCallId: 'call_a' },
		]
		const mutations: Mutation[] = [
			{
				type: 'injectToolResponse',
				toolCallId: 'call_b' as ToolCallId,
				response: { success: true, output: 'mocked-b', data: { x: 1 } },
			},
		]

		const result = applyMutations(messages, mutations)

		expect(result).toHaveLength(4)
		const last = result[3] as ToolMessage
		expect(last.role).toBe('tool')
		expect(last.toolCallId).toBe('call_b')
		expect(last.content).toBe('mocked-b')
	})

	it('throws MutationNotApplicableError when no pending tool calls exist', () => {
		const messages: Message[] = [
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'hello' },
		]
		expect(() =>
			applyMutations(messages, [
				{
					type: 'injectToolResponse',
					toolCallId: 'call_missing' as ToolCallId,
					response: { success: true, output: 'x' },
				},
			]),
		).toThrow(MutationNotApplicableError)
	})

	it('throws with availableToolCallIds populated when toolCallId is not pending', () => {
		const messages: Message[] = [
			{ role: 'user', content: 'do stuff' },
			assistantWithCalls(['call_a', 'call_b']),
		]
		try {
			applyMutations(messages, [
				{
					type: 'injectToolResponse',
					toolCallId: 'call_z' as ToolCallId,
					response: { success: true, output: 'x' },
				},
			])
			expect.fail('expected MutationNotApplicableError')
		} catch (err) {
			expect(err).toBeInstanceOf(MutationNotApplicableError)
			const e = err as MutationNotApplicableError
			expect(e.availableToolCallIds).toEqual(['call_a', 'call_b'])
		}
	})

	it('considers a tool call satisfied only when a subsequent ToolMessage responds to it', () => {
		const messages: Message[] = [
			{ role: 'user', content: 'do stuff' },
			assistantWithCalls(['call_a', 'call_b', 'call_c']),
			{ role: 'tool', content: 'a done', toolCallId: 'call_a' },
			{ role: 'tool', content: 'c done', toolCallId: 'call_c' },
		]
		try {
			applyMutations(messages, [
				{
					type: 'injectToolResponse',
					toolCallId: 'call_a' as ToolCallId,
					response: { success: true, output: 're-answered' },
				},
			])
			expect.fail('expected MutationNotApplicableError — call_a already satisfied')
		} catch (err) {
			const e = err as MutationNotApplicableError
			expect(e.availableToolCallIds).toEqual(['call_b'])
		}
	})

	it('applies mutations in order so a later mutation sees earlier ones', () => {
		const messages: Message[] = [
			{ role: 'user', content: 'two calls pending' },
			assistantWithCalls(['call_x', 'call_y']),
		]
		const result = applyMutations(messages, [
			{
				type: 'injectToolResponse',
				toolCallId: 'call_x' as ToolCallId,
				response: { success: true, output: 'x-result' },
			},
			{
				type: 'injectToolResponse',
				toolCallId: 'call_y' as ToolCallId,
				response: { success: true, output: 'y-result' },
			},
		])

		expect(result).toHaveLength(4)
		expect((result[2] as ToolMessage).toolCallId).toBe('call_x')
		expect((result[3] as ToolMessage).toolCallId).toBe('call_y')
	})

	it('returns the original messages unchanged when the mutation list is empty', () => {
		const messages: Message[] = [
			{ role: 'user', content: 'no-op' },
			{ role: 'assistant', content: 'ok' },
		]
		const result = applyMutations(messages, [])
		expect(result).toEqual(messages)
		expect(result).not.toBe(messages)
	})
})
