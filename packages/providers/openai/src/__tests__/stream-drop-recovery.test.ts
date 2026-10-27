import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type StreamChunk, withProviderRetry } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CodexProvider, OpenAIProvider } from '../index.js'

/**
 * A provider whose connection is cut on purpose: before the first byte, in the
 * middle of text, in the middle of a tool call's arguments, and by a clean
 * close that never says the response is over. Each must reach the retry as a
 * network failure and be sent again, with no wait that depends on the clock.
 */

type Scenario = 'reset-first' | 'reset-in-text' | 'reset-in-call' | 'quiet-close' | 'whole-text'

const sse = (delta: Record<string, unknown>, finish: string | null = null) =>
	`data: ${JSON.stringify({
		id: 'chatcmpl-1',
		object: 'chat.completion.chunk',
		choices: [{ index: 0, delta, finish_reason: finish }],
	})}\n\n`

function respond(scenario: Scenario, req: IncomingMessage, res: ServerResponse): void {
	if (scenario === 'reset-first') {
		req.socket.destroy()
		return
	}
	res.writeHead(200, { 'content-type': 'text/event-stream' })
	if (scenario === 'reset-in-text') {
		res.write(sse({ role: 'assistant', content: 'The first hal' }))
		setImmediate(() => req.socket.destroy())
		return
	}
	if (scenario === 'reset-in-call') {
		res.write(
			sse({
				tool_calls: [
					{ index: 0, id: 'call_1', type: 'function', function: { name: 'write', arguments: '' } },
				],
			}),
		)
		res.write(
			sse({ tool_calls: [{ index: 0, function: { arguments: '{"content":"a long scr' } }] }),
		)
		setImmediate(() => req.socket.destroy())
		return
	}
	if (scenario === 'quiet-close') {
		res.write(sse({ role: 'assistant', content: 'A reply that never says it is over' }))
		res.end()
		return
	}
	res.write(sse({ role: 'assistant', content: 'The whole reply' }))
	res.write(sse({}, 'stop'))
	res.write(
		`data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })}\n\n`,
	)
	res.write('data: [DONE]\n\n')
	res.end()
}

const servers: Server[] = []

/** Serves `script[n]` to request n; the last entry serves every request after it. */
async function fakeProvider(script: readonly Scenario[]) {
	let requests = 0
	const server = createServer((req, res) => {
		const scenario = script[Math.min(requests, script.length - 1)] ?? 'whole-text'
		requests++
		req.resume()
		respond(scenario, req, res)
	})
	servers.push(server)
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo
	const provider = new OpenAIProvider({
		apiKey: 'fixture',
		baseURL: `http://127.0.0.1:${port}/v1`,
		model: 'm',
		// The vendor client's own retry would add waits of its own.
		maxRetries: 0,
	})
	return { provider, requests: () => requests, port }
}

/** The address of a server that has been closed: connecting is refused. */
async function refusedPort(): Promise<number> {
	const server = createServer()
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo
	await new Promise<void>((resolve) => server.close(() => resolve()))
	return port
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections()
					server.close(() => resolve())
				}),
		),
	)
})

const PARAMS = { model: 'm', messages: [{ role: 'user', content: 'go' }] } as never

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
	const out: StreamChunk[] = []
	for await (const chunk of stream) out.push(chunk)
	return out
}

const text = (chunks: readonly StreamChunk[]) =>
	chunks
		.filter((c) => !c.retry)
		.map((c) => c.delta.content ?? '')
		.join('')

function retrying(provider: OpenAIProvider, retryMidStream = false) {
	const waits: number[] = []
	const wrapped = withProviderRetry(provider, {
		config: {
			maxRetries: 10,
			initialDelayMs: 500,
			maxDelayMs: 32_000,
			jitter: 'proportional',
			retryMidStream,
		},
		random: () => 0,
		sleepFn: async (ms) => {
			waits.push(ms)
		},
	})
	return { wrapped, waits }
}

describe('a stream cut by the connection (chat completions)', () => {
	it('before the first byte: the same request is sent again', async () => {
		const { provider, requests } = await fakeProvider(['reset-first', 'whole-text'])
		const { wrapped, waits } = retrying(provider)
		const chunks = await collect(wrapped.chatStream(PARAMS))
		expect(text(chunks)).toBe('The whole reply')
		expect(requests()).toBe(2)
		expect(waits).toEqual([500])
		expect(chunks.filter((c) => c.retry)).toMatchObject([
			{ retry: { attempt: 1, code: 'network' } },
		])
	})

	it('in the middle of text: restarts when the host can take text back, and only then', async () => {
		const screen = await fakeProvider(['reset-in-text', 'whole-text'])
		const restarted = await collect(retrying(screen.provider, true).wrapped.chatStream(PARAMS))
		expect(restarted.filter((c) => c.retry)).toMatchObject([{ retry: { restart: true } }])
		expect(text(restarted.slice(restarted.findIndex((c) => c.retry) + 1))).toBe('The whole reply')

		const pipe = await fakeProvider(['reset-in-text', 'whole-text'])
		await expect(collect(retrying(pipe.provider).wrapped.chatStream(PARAMS))).rejects.toMatchObject(
			{
				kind: 'network',
			},
		)
		expect(pipe.requests()).toBe(1)
	})

	it('in the middle of a tool call: the half-written call is dropped and the request is sent again', async () => {
		const { provider, requests } = await fakeProvider(['reset-in-call', 'whole-text'])
		const { wrapped } = retrying(provider)
		const chunks = await collect(wrapped.chatStream(PARAMS))
		const retry = chunks.find((c) => c.retry)
		expect(retry?.retry).toMatchObject({ attempt: 1, code: 'network', restart: true })
		// Nothing of the half-written call comes after the restart.
		const after = chunks.slice(chunks.indexOf(retry as StreamChunk) + 1)
		expect(after.some((c) => c.delta.toolCalls?.length)).toBe(false)
		expect(text(after)).toBe('The whole reply')
		expect(requests()).toBe(2)
	})

	it('a close with no end-of-response marker is a network failure, not a finished reply', async () => {
		const { provider } = await fakeProvider(['quiet-close'])
		await expect(collect(provider.chatStream(PARAMS))).rejects.toMatchObject({
			kind: 'network',
			providerId: 'openai',
		})
	})

	it('a quiet close is retried like any other drop', async () => {
		const { provider, requests } = await fakeProvider(['quiet-close', 'whole-text'])
		const chunks = await collect(retrying(provider, true).wrapped.chatStream(PARAMS))
		expect(text(chunks.slice(chunks.findIndex((c) => c.retry) + 1))).toBe('The whole reply')
		expect(requests()).toBe(2)
	})

	it('a refused connection is retried with a growing wait until the attempts are spent', async () => {
		const port = await refusedPort()
		const provider = new OpenAIProvider({
			apiKey: 'fixture',
			baseURL: `http://127.0.0.1:${port}/v1`,
			model: 'm',
			maxRetries: 0,
		})
		const { wrapped, waits } = retrying(provider)
		const failure = await collect(wrapped.chatStream(PARAMS)).catch((error: unknown) => error)
		expect(failure).toMatchObject({ kind: 'network' })
		expect(waits).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 32_000, 32_000, 32_000])
	})
})

describe('a Responses stream cut by the connection', () => {
	function codexOver(events: unknown[]) {
		const provider = new CodexProvider({ accessToken: 'fixture', accountId: 'fixture', model: 'm' })
		;(provider as unknown as { client: unknown }).client = {
			responses: {
				create: vi.fn(async () =>
					(async function* () {
						for (const event of events) yield event
					})(),
				),
			},
		}
		return provider
	}

	it('closing without a completed or incomplete event is a network failure', async () => {
		const provider = codexOver([
			{ type: 'response.created', response: { id: 'resp_1' } },
			{
				type: 'response.output_item.added',
				output_index: 0,
				item: {
					type: 'function_call',
					id: 'fc_1',
					call_id: 'call_1',
					name: 'write',
					arguments: '',
				},
			},
			{
				type: 'response.function_call_arguments.delta',
				item_id: 'fc_1',
				output_index: 0,
				delta: '{"content":"half',
			},
		])
		await expect(collect(provider.chatStream(PARAMS))).rejects.toMatchObject({
			kind: 'network',
			providerId: expect.any(String),
		})
	})
})
