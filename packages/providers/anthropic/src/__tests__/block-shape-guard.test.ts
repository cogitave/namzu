import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { AnthropicProvider } from '../client.js'

/**
 * The wire rejects a whole request over one malformed block, so the
 * failures that matter here are structural: a block in the wrong place, a
 * message whose content array is empty, an orphan tool result, or a
 * `tool_choice` sent without tools. None of them is visible in isolation —
 * each shows up as a 400 for the entire conversation.
 *
 * These pin the shapes the mapper must not produce, alongside the ones it
 * must. What must NOT hold is the point: a guard asserting only the happy
 * shape passes while the mapper emits a request no server accepts.
 */

function bodyCapturer() {
	const seen: { body?: Record<string, unknown> } = {}
	const provider = new AnthropicProvider({ apiKey: 'test-key' })
	;(provider as unknown as { client: { messages: { create: unknown } } }).client = {
		messages: {
			create: vi.fn(async (body: Record<string, unknown>) => {
				seen.body = body
				return (async function* () {
					yield { type: 'message_start', message: { id: 'msg_1' } }
				})()
			}),
		},
	}
	return { provider, seen }
}

async function bodyFor(params: Partial<ChatCompletionParams>): Promise<Record<string, unknown>> {
	const { provider, seen } = bodyCapturer()
	for await (const _chunk of provider.chatStream({
		model: 'm',
		messages: [{ role: 'user', content: 'hi' }],
		...params,
	} as ChatCompletionParams)) {
		// drain
	}
	return seen.body ?? {}
}

type WireMessage = { role: string; content: string | Array<Record<string, unknown>> }

function messagesOf(body: Record<string, unknown>): WireMessage[] {
	return (body.messages ?? []) as WireMessage[]
}

function allBlocks(body: Record<string, unknown>): Array<Record<string, unknown>> {
	return messagesOf(body).flatMap((m) => (Array.isArray(m.content) ? m.content : []))
}

const TOOLS = [
	{
		type: 'function' as const,
		function: { name: 'read', description: 'read', parameters: { type: 'object' } },
	},
]

describe('no message goes out with an empty content array', () => {
	it('holds for a plain conversation', async () => {
		const body = await bodyFor({
			messages: [
				{ role: 'user', content: 'a' },
				{ role: 'assistant', content: 'b' },
			] as ChatCompletionParams['messages'],
		})

		for (const message of messagesOf(body)) {
			if (Array.isArray(message.content)) expect(message.content.length).toBeGreaterThan(0)
		}
	})

	it('holds for an assistant turn that called a tool with no prose', async () => {
		const body = await bodyFor({
			messages: [
				{ role: 'user', content: 'read it' },
				{
					role: 'assistant',
					content: null,
					toolCalls: [
						{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } },
					],
				},
				{ role: 'tool', toolCallId: 'call_1', content: 'file body' },
			] as unknown as ChatCompletionParams['messages'],
		})

		for (const message of messagesOf(body)) {
			if (Array.isArray(message.content)) expect(message.content.length).toBeGreaterThan(0)
		}
	})
})

describe('a system message never appears among the turns', () => {
	it('is lifted out entirely, not left as a user message', async () => {
		const body = await bodyFor({
			messages: [
				{ role: 'system', content: 'be terse' },
				{ role: 'user', content: 'hi' },
			] as ChatCompletionParams['messages'],
		})

		expect(messagesOf(body).map((m) => m.role)).toEqual(['user'])
		expect(body.system).toBeDefined()
	})
})

describe('tool results are grouped into one user turn, in order', () => {
	it('collapses two results answering one assistant turn', async () => {
		const body = await bodyFor({
			messages: [
				{ role: 'user', content: 'read both' },
				{
					role: 'assistant',
					content: null,
					toolCalls: [
						{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } },
						{ id: 'call_2', type: 'function', function: { name: 'read', arguments: '{}' } },
					],
				},
				{ role: 'tool', toolCallId: 'call_1', content: 'one' },
				{ role: 'tool', toolCallId: 'call_2', content: 'two' },
			] as unknown as ChatCompletionParams['messages'],
		})

		const resultTurns = messagesOf(body).filter(
			(m) => Array.isArray(m.content) && m.content.every((b) => b.type === 'tool_result'),
		)
		expect(resultTurns).toHaveLength(1)
		expect(
			(resultTurns[0]?.content as Array<Record<string, unknown>>).map((b) => b.tool_use_id),
		).toEqual(['call_1', 'call_2'])
	})

	it('every tool result answers a tool call that was actually made', async () => {
		const body = await bodyFor({
			messages: [
				{ role: 'user', content: 'read it' },
				{
					role: 'assistant',
					content: null,
					toolCalls: [
						{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } },
					],
				},
				{ role: 'tool', toolCallId: 'call_1', content: 'body' },
			] as unknown as ChatCompletionParams['messages'],
		})

		const issued = new Set(
			allBlocks(body)
				.filter((b) => b.type === 'tool_use')
				.map((b) => b.id),
		)
		for (const result of allBlocks(body).filter((b) => b.type === 'tool_result')) {
			// An orphan tool_result is rejected for the whole conversation.
			expect(issued.has(result.tool_use_id)).toBe(true)
		}
	})

	it('places the results after the turn that asked for them', async () => {
		const body = await bodyFor({
			messages: [
				{ role: 'user', content: 'read it' },
				{
					role: 'assistant',
					content: null,
					toolCalls: [
						{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } },
					],
				},
				{ role: 'tool', toolCallId: 'call_1', content: 'body' },
			] as unknown as ChatCompletionParams['messages'],
		})
		const roles = messagesOf(body).map((m) => m.role)

		expect(roles).toEqual(['user', 'assistant', 'user'])
	})
})

describe('a malformed tool argument does not become a malformed block', () => {
	it('sends an empty object rather than an unparsed string', async () => {
		const body = await bodyFor({
			messages: [
				{ role: 'user', content: 'go' },
				{
					role: 'assistant',
					content: null,
					toolCalls: [
						{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{not json' } },
					],
				},
			] as unknown as ChatCompletionParams['messages'],
		})

		expect(allBlocks(body).find((b) => b.type === 'tool_use')?.input).toEqual({})
	})

	it('reads empty arguments as an empty object', async () => {
		const body = await bodyFor({
			messages: [
				{ role: 'user', content: 'go' },
				{
					role: 'assistant',
					content: null,
					toolCalls: [
						{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '' } },
					],
				},
			] as unknown as ChatCompletionParams['messages'],
		})

		expect(allBlocks(body).find((b) => b.type === 'tool_use')?.input).toEqual({})
	})
})

describe('tool_choice is only legal beside tools', () => {
	it('is sent when tools are', async () => {
		const body = await bodyFor({ tools: TOOLS, toolChoice: 'required' })

		expect(body.tools).toBeDefined()
		expect(body.tool_choice).toBeDefined()
	})

	it('is withheld when there are no tools', async () => {
		const body = await bodyFor({ toolChoice: 'required' })

		// The API rejects the request outright; a driver that forwards it
		// turns a caller's harmless default into a hard failure.
		expect(body.tool_choice).toBeUndefined()
	})

	it('is withheld when a parallel-call hint is the only reason for it', async () => {
		const body = await bodyFor({ parallelToolCalls: false })

		expect(body.tool_choice).toBeUndefined()
	})
})

describe('the required fields are always present', () => {
	it('always sends max_tokens, which the API demands', async () => {
		expect(await bodyFor({})).toHaveProperty('max_tokens')
	})

	it('honours the caller max over the default', async () => {
		expect(await bodyFor({ maxTokens: 128 })).toMatchObject({ max_tokens: 128 })
	})

	it('marks the request as streaming', async () => {
		expect(await bodyFor({})).toMatchObject({ stream: true })
	})
})
