import { describe, expect, it, vi } from 'vitest'

import { collect } from '../../provider/collect.js'
import type { ChatCompletionParams } from '../../types/provider/index.js'
import { MOCK_CAPABILITIES } from '../mock-register.js'
import { MockLLMProvider } from '../mock.js'

/**
 * The mock could only emit text, and declared `supportsTools: false`, so
 * capability negotiation stripped the tool surface before a request was even
 * built. No consumer could test that the agent loop calls their tool — and
 * namzu's own maintainers hand-rolled eight `implements LLMProvider` fakes
 * across seven test files to work around exactly that.
 *
 * These cases assert the mock produces the frame sequence a REAL driver
 * produces, so a test written against it exercises the consumer path rather
 * than a shortcut through it.
 */

const PARAMS = { model: 'mock', messages: [] } as unknown as ChatCompletionParams

describe('MockLLMProvider — scripted tool calls', () => {
	it('declares tool support, so capability negotiation does not strip tools', () => {
		expect(MOCK_CAPABILITIES.supportsTools).toBe(true)
		expect(MOCK_CAPABILITIES.supportsFunctionCalling).toBe(true)
	})

	it('emits a tool call the aggregator can reassemble', async () => {
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'read', args: { path: 'a.txt' } }] }],
		})

		const response = await collect(provider.chatStream(PARAMS))

		expect(response.finishReason).toBe('tool_calls')
		expect(response.message.toolCalls).toHaveLength(1)
		const call = response.message.toolCalls?.[0]
		expect(call?.function.name).toBe('read')
		expect(JSON.parse(call?.function.arguments ?? '{}')).toEqual({ path: 'a.txt' })
	})

	it('streams arguments in fragments — the buffering path is real, not bypassed', async () => {
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'grep', args: { pattern: 'needle' }, argChunkSize: 2 }] }],
		})

		const fragments: string[] = []
		for await (const chunk of provider.chatStream(PARAMS)) {
			const args = chunk.delta.toolCalls?.[0]?.function?.arguments
			if (args) fragments.push(args)
		}

		expect(fragments.length).toBeGreaterThan(3)
		expect(JSON.parse(fragments.join(''))).toEqual({ pattern: 'needle' })
	})

	it('opens each block with id + name and closes it with toolCallEnd', async () => {
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'ls', id: 'call_x' }] }],
		})

		let opened = false
		let closed = false
		for await (const chunk of provider.chatStream(PARAMS)) {
			const tc = chunk.delta.toolCalls?.[0]
			if (tc?.id === 'call_x' && tc.function?.name === 'ls') opened = true
			if (chunk.delta.toolCallEnd?.id === 'call_x') closed = true
		}

		expect(opened).toBe(true)
		expect(closed).toBe(true)
	})

	it('can emit several tool calls in one turn, each on its own index', async () => {
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }],
		})
		const response = await collect(provider.chatStream(PARAMS))
		expect(response.message.toolCalls?.map((t) => t.function.name)).toEqual(['a', 'b', 'c'])
	})

	it('reproduces a tool call cut off mid-JSON', async () => {
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'write', args: { content: 'x' }, truncateArguments: true }] }],
		})

		let sawEnd = false
		for await (const chunk of provider.chatStream(PARAMS)) {
			if (chunk.delta.toolCallEnd) sawEnd = true
		}
		// No block-close signal — the consumer must infer truncation.
		expect(sawEnd).toBe(false)
	})
})

describe('MockLLMProvider — multi-turn scripts', () => {
	it('plays turns in order', async () => {
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'read' }] }, { text: 'all done' }],
		})

		const first = await collect(provider.chatStream(PARAMS))
		const second = await collect(provider.chatStream(PARAMS))

		expect(first.message.toolCalls).toHaveLength(1)
		expect(second.message.content).toBe('all done')
		expect(second.finishReason).toBe('stop')
	})

	it('repeats the last turn rather than exhausting, so a loop bug reads as repetition', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'only' }] })
		await collect(provider.chatStream(PARAMS))
		const third = await collect(provider.chatStream(PARAMS))
		expect(third.message.content).toBe('only')
	})

	it('nextTurn can decide from the request it just received', async () => {
		const provider = new MockLLMProvider({
			nextTurn: (_params, i) =>
				i === 0 ? { toolCalls: [{ name: 'read' }] } : { text: `turn ${i}` },
		})
		expect((await collect(provider.chatStream(PARAMS))).message.toolCalls).toHaveLength(1)
		expect((await collect(provider.chatStream(PARAMS))).message.content).toBe('turn 1')
	})

	it('captures requests so a test can assert on tools / toolChoice / cacheControl', async () => {
		const onRequest = vi.fn()
		const provider = new MockLLMProvider({ turns: [{ text: 'hi' }], onRequest })

		await collect(provider.chatStream({ ...PARAMS, toolChoice: 'none' }))

		expect(onRequest).toHaveBeenCalledTimes(1)
		expect(provider.requests[0]?.toolChoice).toBe('none')
	})

	it('reset() rewinds the script and clears captured requests', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'first' }, { text: 'second' }] })
		await collect(provider.chatStream(PARAMS))
		provider.reset()
		expect((await collect(provider.chatStream(PARAMS))).message.content).toBe('first')
		expect(provider.requests).toHaveLength(1)
	})
})

describe('MockLLMProvider — failure injection', () => {
	it('can fail a request outright with a status, for retry tests', async () => {
		const provider = new MockLLMProvider({
			turns: [{ error: { message: 'rate limited', status: 429 } }],
		})
		await expect(collect(provider.chatStream(PARAMS))).rejects.toMatchObject({ status: 429 })
	})

	it('can fail mid-stream after N chunks, for recovery tests', async () => {
		const provider = new MockLLMProvider({
			turns: [{ text: 'abcdefghijkl', chunkSize: 4, throwAfterChunks: 2 }],
		})

		const seen: string[] = []
		await expect(
			(async () => {
				for await (const chunk of provider.chatStream(PARAMS)) {
					if (chunk.delta.content) seen.push(chunk.delta.content)
				}
			})(),
		).rejects.toThrow('mock stream failure')

		expect(seen).toEqual(['abcd', 'efgh'])
	})
})

describe('MockLLMProvider — back-compat', () => {
	it('still accepts the old responseText shorthand', async () => {
		const provider = new MockLLMProvider({ responseText: 'legacy' })
		expect((await collect(provider.chatStream(PARAMS))).message.content).toBe('legacy')
	})
})
