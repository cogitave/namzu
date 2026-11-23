import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { CodexProvider } from '../index.js'

const finishedStream = () =>
	(async function* () {
		yield { type: 'response.completed', response: { id: 'resp_fixture', output: [], usage: {} } }
	})()

interface Captured {
	body: Record<string, unknown>
	headers: Record<string, string> | undefined
}

async function capture(params: ChatCompletionParams): Promise<Captured> {
	const provider = new CodexProvider({
		accessToken: 'access',
		accountId: 'account',
		model: 'gpt-fixture',
	})
	const create = vi.fn(async () => finishedStream())
	;(provider as unknown as { client: { responses: { create: unknown } } }).client.responses = {
		create,
	}
	for await (const _ of provider.chatStream(params)) {
		// drain
	}
	const call = create.mock.calls[0] as unknown as [
		Record<string, unknown>,
		{ headers?: Record<string, string> },
	]
	return { body: call[0], headers: call[1].headers }
}

const TOOLS = [
	{
		type: 'function' as const,
		function: { name: 'Read', description: 'Read a file', parameters: { type: 'object' } },
	},
	{
		type: 'function' as const,
		function: { name: 'Bash', description: 'Run a command', parameters: { type: 'object' } },
	},
]

function history(toolResult: string): ChatCompletionParams['messages'] {
	return [
		{
			role: 'system',
			content: 'You are the standing instructions. '.repeat(40),
			cacheHint: 'cache',
		},
		{ role: 'user', content: 'Please look at the repository and report. '.repeat(10) },
		{
			role: 'assistant',
			content: '',
			toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{}' } }],
		},
		{ role: 'tool', toolCallId: 'call_1', content: toolResult },
	]
}

/** What a step adds after the history: a changing preamble and a request-only note. */
function withStepTail(
	messages: ChatCompletionParams['messages'],
	stamp: string,
): ChatCompletionParams['messages'] {
	return [
		...messages,
		{ role: 'system', content: `Step guidance, turn note ${stamp}` },
		{ role: 'user', content: `<context>clock ${stamp}</context>` },
	]
}

function sharedPrefix(a: string, b: string): number {
	let i = 0
	while (i < a.length && i < b.length && a[i] === b[i]) i++
	return i
}

const serialize = (body: Record<string, unknown>) => JSON.stringify(body)

describe('Codex requests of one conversation', () => {
	it('send one cache key, and a changing step preamble does not reach the instructions', async () => {
		const one = await capture({
			model: 'gpt-fixture',
			messages: withStepTail(history('first result'), 'turn-1'),
			tools: TOOLS,
			cacheKey: 'ses_stable',
		})
		const two = await capture({
			model: 'gpt-fixture',
			messages: withStepTail(history('first result'), 'turn-2'),
			tools: TOOLS,
			cacheKey: 'ses_stable',
		})
		expect(one.body.prompt_cache_key).toBe('ses_stable')
		expect(two.body.prompt_cache_key).toBe('ses_stable')
		expect(one.headers?.session_id).toBe('ses_stable')
		expect(one.body.instructions).toBe(two.body.instructions)
		expect(String(one.body.instructions)).not.toContain('Step guidance')
		const input = one.body.input as { role?: string; content?: unknown }[]
		expect(input.some((item) => item.role === 'developer')).toBe(true)
	})

	it('share at least 90% of the serialized request when one tool result is added', async () => {
		const long = 'line of repository output\n'.repeat(400)
		const first = withStepTail(history(long), 'turn-1')
		const second = withStepTail(
			[
				...history(long),
				{
					role: 'assistant',
					content: '',
					toolCalls: [
						{ id: 'call_2', type: 'function', function: { name: 'Bash', arguments: '{}' } },
					],
				},
				{ role: 'tool', toolCallId: 'call_2', content: 'x'.repeat(300) },
			],
			'turn-2',
		)
		const a = await capture({ model: 'gpt-fixture', messages: first, tools: TOOLS, cacheKey: 'k' })
		const b = await capture({ model: 'gpt-fixture', messages: second, tools: TOOLS, cacheKey: 'k' })
		const sa = serialize(a.body)
		const sb = serialize(b.body)
		// The wire order is instructions, tools, then input: the history is the
		// shared prefix and the step tail is what differs.
		const shared = sharedPrefix(sa, sb)
		expect(shared / Math.min(sa.length, sb.length)).toBeGreaterThanOrEqual(0.9)
	})

	it('omits the key when the caller names none', async () => {
		const sent = await capture({ model: 'gpt-fixture', messages: history('r'), tools: TOOLS })
		expect('prompt_cache_key' in sent.body).toBe(false)
		expect(sent.headers).toBeUndefined()
	})
})
