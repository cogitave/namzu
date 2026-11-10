import type { ChatCompletionParams, StreamChunk } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'
import { AnthropicProvider, OFFLINE_MODEL_CATALOGUE } from '../client.js'

type Body = Record<string, unknown> & { messages: Record<string, unknown>[] }

const request: ChatCompletionParams = {
	model: 'claude-sonnet-5',
	messages: [{ role: 'user', content: 'Search' }],
	webSearch: { mode: 'live' },
}

/** A response that stops with `stop`, after a search call (and its result when `withResult`). */
function response(id: string, stop: string, opts: { withResult?: boolean; text?: string } = {}) {
	const blocks: Record<string, unknown>[] = [
		{ type: 'server_tool_use', id: `${id}-s`, name: 'web_search', input: {} },
	]
	if (opts.withResult) {
		blocks.push({
			type: 'web_search_tool_result',
			tool_use_id: `${id}-s`,
			content: [
				{
					type: 'web_search_result',
					url: 'https://example.com',
					title: 'T',
					encrypted_content: 'x',
				},
			],
		})
	}
	if (opts.text) blocks.push({ type: 'text', text: '' })
	const events: Record<string, unknown>[] = [
		{
			type: 'message_start',
			message: {
				id,
				usage: { input_tokens: 10, output_tokens: 1, server_tool_use: { web_search_requests: 0 } },
			},
		},
	]
	blocks.forEach((block, index) => {
		events.push({ type: 'content_block_start', index, content_block: block })
		if (block.type === 'server_tool_use') {
			events.push({
				type: 'content_block_delta',
				index,
				delta: { type: 'input_json_delta', partial_json: '{"query":"q"}' },
			})
		}
		if (block.type === 'text') {
			events.push({
				type: 'content_block_delta',
				index,
				delta: { type: 'text_delta', text: opts.text },
			})
		}
		events.push({ type: 'content_block_stop', index })
	})
	events.push({
		type: 'message_delta',
		delta: { stop_reason: stop },
		usage: { output_tokens: 5, server_tool_use: { web_search_requests: 1 } },
	})
	events.push({ type: 'message_stop' })
	return events
}

function providerFor(
	responses: Record<string, unknown>[][],
	config: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {},
) {
	let call = 0
	const create = vi.fn(async (_body: Body) => {
		const events = responses[Math.min(call++, responses.length - 1)] ?? []
		return (async function* () {
			for (const event of events) yield event
		})()
	})
	const provider = new AnthropicProvider({ apiKey: 'fixture', ...config })
	;(provider as unknown as { client: unknown }).client = { messages: { create } }
	return { provider, create }
}

async function collect(provider: AnthropicProvider, params: ChatCompletionParams) {
	const chunks: StreamChunk[] = []
	for await (const chunk of provider.chatStream(params)) chunks.push(chunk)
	return chunks
}

describe('pause_turn', () => {
	it('sends the paused content back unchanged and finishes once', async () => {
		const { provider, create } = providerFor([
			response('m1', 'pause_turn'),
			response('m2', 'end_turn', { withResult: true, text: 'Found.' }),
		])
		const chunks = await collect(provider, request)

		expect(create).toHaveBeenCalledTimes(2)
		const second = create.mock.calls[1]?.[0] as Body
		expect(second.messages).toHaveLength(2)
		expect(second.messages[1]).toEqual({
			role: 'assistant',
			content: [{ type: 'server_tool_use', id: 'm1-s', name: 'web_search', input: { query: 'q' } }],
		})
		// One finish for the whole turn, and the model's text is not lost.
		expect(chunks.filter((c) => c.finishReason !== undefined)).toHaveLength(1)
		expect(chunks.at(-1)?.replayState).toBeDefined()
		expect(chunks.map((c) => c.delta.content ?? '').join('')).toContain('Found.')
	})

	it('adds the requests up and counts the searches once each', async () => {
		const { provider } = providerFor([
			response('m1', 'pause_turn'),
			response('m2', 'end_turn', { withResult: true, text: 'ok' }),
		])
		const chunks = await collect(provider, request)
		const last = chunks.flatMap((c) => (c.usage ? [c.usage] : [])).at(-1)
		expect(last?.promptTokens).toBe(20)
		expect(last?.completionTokens).toBe(10)
		expect(last?.totalTokens).toBe(30)
		expect(last?.webSearchRequests).toBe(2)
	})

	it('gives the continuation fresh block indices so earlier blocks are not overwritten', async () => {
		const { provider } = providerFor([
			response('m1', 'pause_turn'),
			response('m2', 'end_turn', { withResult: true, text: 'ok' }),
		])
		const chunks = await collect(provider, request)
		const ids = chunks.flatMap((c) => (c.delta.hostedTool ? [c.delta.hostedTool.id] : []))
		expect(ids).toEqual(['m1-s', 'm2-s', 'm2-s'])
	})

	it('continues when a later paused request reported no usage', async () => {
		const silent = response('m2', 'pause_turn').filter((e) => e.type !== 'message_start')
		silent.unshift({ type: 'message_start', message: { id: 'm2' } })
		const { provider } = providerFor([
			response('m1', 'pause_turn'),
			silent,
			response('m3', 'end_turn', { withResult: true, text: 'ok' }),
		])
		const chunks = await collect(provider, request)
		expect(chunks.filter((c) => c.finishReason !== undefined)).toHaveLength(1)
	})

	it('stops after five continuations and reports the answer unfinished', async () => {
		const { provider, create } = providerFor([response('m', 'pause_turn')])
		await expect(collect(provider, request)).rejects.toMatchObject({
			kind: 'server',
			detail: expect.stringContaining('unfinished'),
		})
		// The first request plus five continuations, never a sixth.
		expect(create).toHaveBeenCalledTimes(6)
	})
})

describe('cache diagnostics', () => {
	const plain: ChatCompletionParams = {
		model: 'claude-sonnet-5',
		messages: [{ role: 'user', content: 'Hello' }],
	}
	const answer = (id: string, diagnostics?: unknown) => [
		{ type: 'message_start', message: { id, usage: { input_tokens: 1 }, diagnostics } },
		{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
		{ type: 'message_stop' },
	]

	it('opts in on the first request with null, then names the response it continues', async () => {
		const { provider, create } = providerFor([answer('msg_1'), answer('msg_2')])
		await collect(provider, plain)
		await collect(provider, {
			...plain,
			messages: [
				...plain.messages,
				{ role: 'assistant', content: 'Hi' },
				{ role: 'user', content: 'More' },
			],
		})
		expect((create.mock.calls[0]?.[0] as Body).diagnostics).toEqual({ previous_message_id: null })
		expect((create.mock.calls[1]?.[0] as Body).diagnostics).toEqual({
			previous_message_id: 'msg_1',
		})
	})

	it('does not name a response that never finished', async () => {
		const aborted = [
			{ type: 'message_start', message: { id: 'msg_lost', usage: { input_tokens: 1 } } },
		]
		const { provider, create } = providerFor([aborted, answer('msg_2')])
		await expect(collect(provider, plain)).rejects.toBeDefined()
		await collect(provider, plain)
		expect((create.mock.calls[1]?.[0] as Body).diagnostics).toEqual({ previous_message_id: null })
	})

	it('does not name another conversation’s response', async () => {
		const { provider, create } = providerFor([answer('msg_1'), answer('msg_2')])
		await collect(provider, plain)
		await collect(provider, { ...plain, messages: [{ role: 'user', content: 'Unrelated' }] })
		expect((create.mock.calls[1]?.[0] as Body).diagnostics).toEqual({ previous_message_id: null })
	})

	it.each([
		['a compatible endpoint', { baseURL: 'https://api.anthropic.com', compatibleEndpoint: true }],
		['a third-party host', { baseURL: 'https://proxy.example.com' }],
	])('sends nothing to %s', async (_name, config) => {
		const { provider, create } = providerFor([answer('msg_1')], config)
		await collect(provider, plain)
		expect(create.mock.calls[0]?.[0]).not.toHaveProperty('diagnostics')
	})

	it('reads a miss into usage, and nothing for a hit or a pending answer', async () => {
		const miss = providerFor([
			answer('a', {
				cache_miss_reason: { type: 'system_changed', cache_missed_input_tokens: 1200 },
			}),
		])
		const usage = (await collect(miss.provider, plain)).flatMap((c) => (c.usage ? [c.usage] : []))
		expect(usage[0]?.cacheMiss).toEqual({ reason: 'system_changed', missedTokens: 1200 })

		for (const diagnostics of [null, undefined, { cache_miss_reason: null }]) {
			const hit = providerFor([answer('b', diagnostics)])
			const frames = (await collect(hit.provider, plain)).flatMap((c) => (c.usage ? [c.usage] : []))
			expect(frames.some((u) => u.cacheMiss !== undefined)).toBe(false)
		}
	})
})

describe('usage fields', () => {
	it('reads the tier, the region and the search count', async () => {
		const { provider } = providerFor([
			[
				{
					type: 'message_start',
					message: {
						id: 'u',
						usage: {
							input_tokens: 3,
							service_tier: 'priority',
							inference_geo: 'us',
							server_tool_use: { web_search_requests: 2 },
						},
					},
				},
				{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
				{ type: 'message_stop' },
			],
		])
		const usage = (
			await collect(provider, {
				model: 'claude-sonnet-5',
				messages: [{ role: 'user', content: 'x' }],
			})
		).flatMap((c) => (c.usage ? [c.usage] : []))[0]
		expect(usage).toMatchObject({
			serviceTier: 'priority',
			inferenceGeo: 'us',
			webSearchRequests: 2,
		})
	})
})

describe('the offline menu', () => {
	it('offers neither a retired nor a retiring model', () => {
		const ids = OFFLINE_MODEL_CATALOGUE.map((m) => m.id)
		expect(ids).not.toContain('claude-opus-4-1-20250805')
		expect(ids).not.toContain('claude-sonnet-4-5-20250929')
		expect(ids.length).toBeGreaterThan(0)
	})
})
