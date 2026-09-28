import type { LanguageModelV3Content } from '@ai-sdk/provider'
import {
	type AssistantMessage,
	type ChatCompletionParams,
	type Message,
	collectChatCompletion,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZenGoProvider } from '../client.js'
import { createReplayState, toModelPrompt, toReasoningBlocks } from '../prompt.js'

const apiKey = 'go-wire-fixture'
const tool = {
	type: 'function' as const,
	function: {
		name: 'weather',
		description: 'Check the weather',
		parameters: { type: 'object', properties: { city: { type: 'string' } } },
	},
}
const call = {
	id: 'call-weather',
	type: 'function' as const,
	function: { name: 'weather', arguments: '{"city":"Istanbul"}' },
}
const user: Message = { role: 'user', content: 'Check the weather.' }

function capture(): {
	requests: Record<string, unknown>[]
	transport: ReturnType<typeof vi.fn>
} {
	const requests: Record<string, unknown>[] = []
	const transport = vi.fn<typeof fetch>(async (_input, init) => {
		requests.push(JSON.parse(String(init?.body)))
		return Response.json(
			{ error: { message: 'fixture ended after request capture' } },
			{ status: 400 },
		)
	})
	vi.stubGlobal('fetch', transport)
	return { requests, transport }
}

async function send(params: ChatCompletionParams, protocol?: 'chat' | 'responses'): Promise<void> {
	try {
		await collectChatCompletion(
			new ZenGoProvider({ apiKey, ...(protocol && { protocol }) }).chatStream(params),
		)
		throw new Error('Fixture request unexpectedly succeeded.')
	} catch (error) {
		if (error instanceof Error && !error.message.includes('fixture ended after request capture'))
			throw error
	}
}

afterEach(() => vi.unstubAllGlobals())

describe('Zen Go gateway wire compatibility', () => {
	it.each(['deepseek-v4-pro', 'deepseek-v4.1-flash'])(
		'%s Chat replays reasoning_content on tool and text turns',
		async (model) => {
			const { requests } = capture()
			await send({
				model,
				messages: [
					user,
					{ role: 'assistant', content: '', toolCalls: [call] },
					{ role: 'tool', toolCallId: call.id, content: 'Sunny.' },
					{ role: 'assistant', content: 'It is sunny.' },
					{ role: 'user', content: 'Thanks.' },
				],
				tools: [tool],
			})
			expect(requests).toHaveLength(1)
			const messages = requests[0]?.messages as Record<string, unknown>[]
			expect(messages.filter((message) => message.role === 'assistant')).toEqual([
				expect.objectContaining({
					content: '',
					reasoning_content: '',
					tool_calls: expect.arrayContaining([expect.objectContaining({ id: call.id })]),
				}),
				expect.objectContaining({
					content: 'It is sunny.',
					reasoning_content: '',
				}),
			])
			expect(messages.some((message) => message.role === 'tool')).toBe(true)
		},
	)

	it('keeps actual captured Chat reasoning instead of replacing it with empty text', async () => {
		const model = 'deepseek-v4-pro'
		const route = { providerId: 'zen-go', model, chainIndex: 0 }
		const first: ChatCompletionParams = { model, messages: [user] }
		const native: LanguageModelV3Content[] = [
			{ type: 'reasoning', text: 'Use weather tool.' },
			{
				type: 'tool-call',
				toolCallId: call.id,
				toolName: call.function.name,
				input: call.function.arguments,
			},
		]
		const assistant: AssistantMessage = {
			role: 'assistant',
			content: '',
			reasoning: toReasoningBlocks(native),
			toolCalls: [call],
			source: {
				type: 'model',
				...route,
				replayState: createReplayState(first, route, 'go', 'chat', native),
			},
		}
		const { requests } = capture()
		await send({
			model,
			messages: [user, assistant, { role: 'tool', toolCallId: call.id, content: 'Sunny.' }],
		})
		const messages = requests[0]?.messages as Record<string, unknown>[]
		expect(messages.find((message) => message.role === 'assistant')).toMatchObject({
			content: '',
			reasoning_content: 'Use weather tool.',
		})
	})

	it.each(['deepseek-v4-pro', 'deepseek-v4.1-flash', 'deepseek-v4-flash', 'mimo-v2.5-pro'])(
		'%s omits unsupported automatic choice and preserves no-tools finalization',
		async (model) => {
			const { requests } = capture()
			await send({
				model,
				messages: [user],
				tools: [tool],
				toolChoice: 'auto',
			})
			expect(requests[0]).toHaveProperty('tools')
			expect(requests[0]).not.toHaveProperty('tool_choice')

			const second = capture()
			await send({
				model,
				messages:
					model === 'deepseek-v4-flash'
						? [user]
						: [
								user,
								{ role: 'assistant', content: '', toolCalls: [call] },
								{ role: 'tool', toolCallId: call.id, content: 'Sunny.' },
							],
				tools: [tool],
				toolChoice: 'none',
			})
			expect(second.requests[0]).not.toHaveProperty('tools')
			expect(second.requests[0]).not.toHaveProperty('tool_choice')
			if (model !== 'deepseek-v4-flash')
				expect(JSON.stringify(second.requests[0])).toContain(call.id)
		},
	)

	it.each([
		['deepseek-v4-pro', 'required'],
		['deepseek-v4-flash', { type: 'function', function: { name: 'weather' } }],
		['mimo-v2.5', 'required'],
		['mimo-v2.5-pro', { type: 'function', function: { name: 'weather' } }],
	] as const)('refuses %s forced choice %j before POST', async (model, toolChoice) => {
		const { transport } = capture()
		await expect(
			collectChatCompletion(
				new ZenGoProvider({ apiKey }).chatStream({
					model,
					messages: [user],
					tools: [tool],
					toolChoice,
				}),
			),
		).rejects.toMatchObject({ kind: 'bad_request' })
		expect(transport).not.toHaveBeenCalled()
	})

	it('keeps the documented vision-exp tool-choice exception', async () => {
		const { requests } = capture()
		await send({
			model: 'deepseek-v4-flash-vision-exp',
			messages: [user],
			tools: [tool],
			toolChoice: 'required',
		})
		expect(requests[0]?.tool_choice).toBe('required')
	})

	it('requires captured Responses reasoning before any tool continuation POST', async () => {
		const { transport } = capture()
		await expect(
			collectChatCompletion(
				new ZenGoProvider({ apiKey }).chatStream({
					model: 'deepseek-v4-flash',
					messages: [
						user,
						{ role: 'assistant', content: '', toolCalls: [call] },
						{ role: 'tool', toolCallId: call.id, content: 'Sunny.' },
					],
				}),
			),
		).rejects.toMatchObject({
			kind: 'bad_request',
			detail: expect.stringContaining('reasoning_text'),
		})
		expect(transport).not.toHaveBeenCalled()
	})

	it('replays captured Responses reasoning_text before text and tool calls', async () => {
		const model = 'deepseek-v4-flash'
		const route = { providerId: 'zen-go', model, chainIndex: 0 }
		const first: ChatCompletionParams = { model, messages: [user] }
		const native: LanguageModelV3Content[] = [
			{
				type: 'reasoning',
				text: 'Check the weather.',
				providerMetadata: { openai: { itemId: 'reasoning-1' } },
			},
			{
				type: 'tool-call',
				toolCallId: call.id,
				toolName: call.function.name,
				input: call.function.arguments,
			},
			{ type: 'text', text: 'Checking now.' },
		]
		const assistant: AssistantMessage = {
			role: 'assistant',
			content: 'Checking now.',
			reasoning: toReasoningBlocks(native),
			toolCalls: [call],
			source: {
				type: 'model',
				...route,
				replayState: createReplayState(first, route, 'go', 'responses', native),
			},
		}
		expect(assistant.source?.replayState).toBeDefined()
		const preview = toModelPrompt(
			{
				model,
				messages: [user, assistant, { role: 'tool', toolCallId: call.id, content: 'Sunny.' }],
			},
			route,
			'go',
			'responses',
		)
		expect(JSON.stringify(preview)).toContain('Check the weather.')
		expect(JSON.stringify(preview)).toContain('"type":"reasoning"')
		expect(JSON.stringify(preview)).toContain('"itemId":"reasoning-1"')
		const { requests } = capture()
		await send({
			model,
			messages: [user, assistant, { role: 'tool', toolCallId: call.id, content: 'Sunny.' }],
		})
		const input = requests[0]?.input as Record<string, unknown>[]
		expect(input.map((item) => item.type ?? item.role)).toEqual([
			'user',
			'reasoning',
			'assistant',
			'function_call',
			'function_call_output',
		])
		expect(input[1]).toMatchObject({
			content: [{ type: 'reasoning_text', text: 'Check the weather.' }],
		})
		expect(input[1]).not.toHaveProperty('encrypted_content')
	})
})
