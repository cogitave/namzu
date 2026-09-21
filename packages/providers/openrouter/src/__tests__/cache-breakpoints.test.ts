import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { OpenRouterProvider } from '../client.js'

/**
 * The runtime asks for caching on every request with
 * `cacheControl: { type: 'auto' }`. OpenRouter defines a top-level
 * `cache_control` only as `{ type: 'ephemeral' }`, and applies it to the last
 * cacheable block — with request-only context at the tail, the context,
 * which the next request replaces. So the driver places explicit breakpoints
 * inside content parts instead: after the static system text, and at the end
 * of the history before the context.
 */

type Body = { cache_control?: unknown; messages: { role: string; content: unknown }[] }

function body(params: Partial<ChatCompletionParams>): Body {
	const provider = new OpenRouterProvider({ apiKey: 'k' })
	return (
		provider as unknown as {
			buildRequestBody(p: ChatCompletionParams, stream: boolean): Body
		}
	).buildRequestBody(
		{
			model: 'anthropic/claude-sonnet-4.5',
			cacheControl: { type: 'auto' },
			messages: [],
			...params,
		} as ChatCompletionParams,
		true,
	)
}

const context = (content: string) =>
	({
		role: 'user',
		content,
		source: { type: 'runtime-context', kind: 'step-context' },
	}) as ChatCompletionParams['messages'][number]

const MARK = { type: 'ephemeral' }

const HISTORY: ChatCompletionParams['messages'] = [
	{ role: 'system', content: 'static', cacheHint: 'cache' },
	{ role: 'system', content: 'per-run', cacheHint: 'ephemeral' },
	{ role: 'user', content: 'go' },
	{
		role: 'assistant',
		content: '',
		toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
	},
	{ role: 'tool', toolCallId: 'c1', content: 'file text' },
]

describe('OpenRouter cache breakpoints', () => {
	it('sends no top-level cache_control, a value OpenRouter does not define', () => {
		expect(body({ messages: HISTORY }).cache_control).toBeUndefined()
	})

	it('ends the history before request-only context, inside a content part', () => {
		const sent = body({ messages: [...HISTORY, context('PIN'), context('SNAPSHOT')] })
		expect(sent.messages[0]?.content).toEqual([
			{ type: 'text', text: 'static', cache_control: MARK },
		])
		expect(sent.messages[1]?.content).toBe('per-run')
		// The tool result is the last history message: the marker rides its
		// content part, never the message's top level.
		expect(sent.messages[4]).toEqual({
			role: 'tool',
			tool_call_id: 'c1',
			content: [{ type: 'text', text: 'file text', cache_control: MARK }],
		})
		expect(sent.messages[5]?.content).toBe('PIN')
		expect(sent.messages[6]?.content).toBe('SNAPSHOT')
		expect(JSON.stringify(sent).split('cache_control').length - 1).toBe(2)
	})

	it('keeps the prefix byte-identical when only the context changes', () => {
		const upToContext = (b: Body) => JSON.stringify(b.messages.slice(0, HISTORY.length))
		expect(upToContext(body({ messages: [...HISTORY, context('PIN ONE')] }))).toBe(
			upToContext(body({ messages: [...HISTORY, context('PIN TWO')] })),
		)
	})

	it('walks past an assistant turn that holds only tool calls', () => {
		const sent = body({ messages: HISTORY.slice(0, 4).concat(context('PIN')) })
		expect(sent.messages[3]?.content).toBe('')
		expect(sent.messages[2]?.content).toEqual([{ type: 'text', text: 'go', cache_control: MARK }])
	})

	it('passes over the step preamble, a system message that changes per step', () => {
		const sent = body({
			messages: [
				{ role: 'system', content: 'static', cacheHint: 'cache' },
				{ role: 'user', content: 'go' },
				{ role: 'system', content: 'STEP PREAMBLE' },
				context('ctx'),
			],
		})
		expect(sent.messages[1]?.content).toEqual([{ type: 'text', text: 'go', cache_control: MARK }])
		expect(sent.messages[2]?.content).toBe('STEP PREAMBLE')
		expect(sent.messages[3]?.content).toBe('ctx')
		expect(JSON.stringify(sent).split('cache_control').length - 1).toBe(2)
	})

	it('marks the last message when no request-only context is present', () => {
		const sent = body({ messages: HISTORY })
		expect(sent.messages[4]?.content).toEqual([
			{ type: 'text', text: 'file text', cache_control: MARK },
		])
	})

	it('leaves automatically-caching models in the plain string shape', () => {
		const sent = body({ model: 'openai/gpt-5', messages: [...HISTORY, context('PIN')] })
		expect(JSON.stringify(sent)).not.toContain('cache_control')
		expect(sent.messages[4]?.content).toBe('file text')
	})

	it('does not mutate the caller’s message content', () => {
		const parts = [{ type: 'text', text: 'rich' }]
		const messages = [
			{ role: 'user', content: parts } as unknown as ChatCompletionParams['messages'][number],
		]
		body({ messages })
		expect(parts).toEqual([{ type: 'text', text: 'rich' }])
	})
})
