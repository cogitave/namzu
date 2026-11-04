import type { LanguageModelV3Content } from '@ai-sdk/provider'
import {
	type AssistantMessage,
	type ChatCompletionParams,
	type Message,
	collectChatCompletion,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZenGoProvider } from '../client.js'
import { createReplayState, toReasoningBlocks } from '../prompt.js'

const apiKey = 'go-wire-fixture'
const call = (id: string) => ({
	id,
	type: 'function' as const,
	function: { name: 'web_fetch', arguments: '{"url":"https://example.test"}' },
})
const NOT_ALLOWED = 'web_fetch is not allowed in this session.'
const user: Message = { role: 'user', content: 'Look it up.' }

function capture(): Record<string, unknown>[] {
	const requests: Record<string, unknown>[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>(async (_input, init) => {
			requests.push(JSON.parse(String(init?.body)))
			return Response.json(
				{ error: { message: 'fixture ended after request capture' } },
				{ status: 400 },
			)
		}),
	)
	return requests
}

async function send(params: ChatCompletionParams): Promise<void> {
	try {
		await collectChatCompletion(new ZenGoProvider({ apiKey }).chatStream(params))
		throw new Error('Fixture request unexpectedly succeeded.')
	} catch (error) {
		if (error instanceof Error && !error.message.includes('fixture ended after request capture'))
			throw error
	}
}

afterEach(() => vi.unstubAllGlobals())

type Wire = { role: string; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string }

/** No assistant entry without text or calls, and every tool entry follows a call it answers. */
function expectWellFormed(messages: Wire[]): void {
	let open = new Set<string>()
	for (const message of messages) {
		if (message.role === 'assistant') {
			const calls = (message.tool_calls ?? []) as { id: string }[]
			expect(Boolean(message.content) || calls.length > 0).toBe(true)
			open = new Set(calls.map((c) => c.id))
		} else if (message.role === 'tool') {
			expect(open.has(message.tool_call_id as string)).toBe(true)
		} else open = new Set()
	}
}

describe('empty assistant history on the Zen Go chat wire (DeepSeek lane)', () => {
	it('omits an empty reply and keeps both denied calls with their refusals', async () => {
		const requests = capture()
		await send({
			model: 'deepseek-v4-pro',
			messages: [
				user,
				{ role: 'assistant', content: null, toolCalls: [call('call-1'), call('call-2')] },
				{ role: 'tool', toolCallId: 'call-1', content: NOT_ALLOWED, isError: true },
				{ role: 'tool', toolCallId: 'call-2', content: NOT_ALLOWED, isError: true },
				{ role: 'assistant', content: null },
				{ role: 'user', content: '[SYSTEM] Turn is ending.' },
			],
		})
		const messages = requests[0]?.messages as Wire[]
		expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user'])
		expectWellFormed(messages)
	})

	it('omits a reasoning-only reply from its own route instead of sending empty content', async () => {
		const model = 'deepseek-v4-pro'
		const route = { providerId: 'zen-go', model, chainIndex: 0 }
		const native: LanguageModelV3Content[] = [{ type: 'reasoning', text: 'Thinking it over.' }]
		const reply: AssistantMessage = {
			role: 'assistant',
			content: null,
			reasoning: toReasoningBlocks(native),
			source: {
				type: 'model',
				...route,
				replayState: createReplayState({ model, messages: [user] }, route, 'go', 'chat', native),
			},
		}
		const requests = capture()
		await send({
			model,
			messages: [user, reply, { role: 'user', content: '[SYSTEM] Turn is ending.' }],
		})
		const messages = requests[0]?.messages as Wire[]
		expect(messages.map((m) => m.role)).toEqual(['user', 'user'])
		expectWellFormed(messages)
	})
})
