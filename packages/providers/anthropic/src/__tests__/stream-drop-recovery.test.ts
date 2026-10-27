import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type StreamChunk, withProviderRetry } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { AnthropicProvider } from '../client.js'

/**
 * A provider whose connection is cut on purpose: before the first byte, in the
 * middle of text, in the middle of a tool call's arguments, and by a clean
 * close that never sends the end-of-message event. Each must reach the retry
 * as a network failure and be sent again, with no wait that depends on the
 * clock.
 */

type Scenario = 'reset-first' | 'reset-in-text' | 'reset-in-call' | 'quiet-close' | 'whole-text'

const event = (type: string, body: Record<string, unknown>) =>
	`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`

const start = event('message_start', {
	message: {
		id: 'msg_1',
		type: 'message',
		role: 'assistant',
		content: [],
		usage: { input_tokens: 3 },
	},
})

function respond(scenario: Scenario, req: IncomingMessage, res: ServerResponse): void {
	if (scenario === 'reset-first') {
		req.socket.destroy()
		return
	}
	res.writeHead(200, { 'content-type': 'text/event-stream' })
	res.write(start)
	if (scenario === 'reset-in-call') {
		res.write(
			event('content_block_start', {
				index: 0,
				content_block: { type: 'tool_use', id: 'toolu_1', name: 'write', input: {} },
			}),
		)
		res.write(
			event('content_block_delta', {
				index: 0,
				delta: { type: 'input_json_delta', partial_json: '{"content":"a long scr' },
			}),
		)
		setImmediate(() => req.socket.destroy())
		return
	}
	res.write(event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }))
	res.write(
		event('content_block_delta', {
			index: 0,
			delta: {
				type: 'text_delta',
				text: scenario === 'whole-text' ? 'The whole reply' : 'The first hal',
			},
		}),
	)
	if (scenario === 'reset-in-text') {
		setImmediate(() => req.socket.destroy())
		return
	}
	if (scenario === 'quiet-close') {
		res.end()
		return
	}
	res.write(event('content_block_stop', { index: 0 }))
	res.write(
		event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }),
	)
	res.write(event('message_stop', {}))
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
	const provider = new AnthropicProvider({
		apiKey: 'fixture',
		baseURL: `http://127.0.0.1:${port}`,
		maxRetries: 0,
	})
	return { provider, requests: () => requests }
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

const PARAMS = {
	model: 'claude-sonnet-4-5',
	messages: [{ role: 'user', content: 'go' }],
	maxTokens: 64,
} as never

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
	const out: StreamChunk[] = []
	for await (const chunk of stream) out.push(chunk)
	return out
}

const text = (chunks: readonly StreamChunk[]) => chunks.map((c) => c.delta.content ?? '').join('')

function retrying(provider: AnthropicProvider, retryMidStream = false) {
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

describe('a stream cut by the connection (Messages)', () => {
	it('before the first byte: the same request is sent again', async () => {
		const { provider, requests } = await fakeProvider(['reset-first', 'whole-text'])
		const { wrapped, waits } = retrying(provider)
		const chunks = await collect(wrapped.chatStream(PARAMS))
		expect(text(chunks)).toBe('The whole reply')
		expect(requests()).toBe(2)
		expect(waits).toEqual([500])
	})

	it('in the middle of text: restarts when the host can take text back, and only then', async () => {
		const screen = await fakeProvider(['reset-in-text', 'whole-text'])
		const restarted = await collect(retrying(screen.provider, true).wrapped.chatStream(PARAMS))
		const at = restarted.findIndex((c) => c.retry)
		expect(restarted[at]?.retry).toMatchObject({ code: 'network', restart: true })
		expect(text(restarted.slice(at + 1))).toBe('The whole reply')

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
		const chunks = await collect(retrying(provider).wrapped.chatStream(PARAMS))
		const at = chunks.findIndex((c) => c.retry)
		expect(chunks[at]?.retry).toMatchObject({ attempt: 1, code: 'network', restart: true })
		const after = chunks.slice(at + 1)
		expect(after.some((c) => c.delta.toolCalls?.length)).toBe(false)
		expect(text(after)).toBe('The whole reply')
		expect(requests()).toBe(2)
	})

	it('a close with no end-of-message event is a network failure, not a finished reply', async () => {
		const { provider } = await fakeProvider(['quiet-close'])
		await expect(collect(provider.chatStream(PARAMS))).rejects.toMatchObject({
			kind: 'network',
			providerId: 'anthropic',
		})
	})

	it('a refused connection is retried with a growing wait until the attempts are spent', async () => {
		const port = await refusedPort()
		const provider = new AnthropicProvider({
			apiKey: 'fixture',
			baseURL: `http://127.0.0.1:${port}`,
			maxRetries: 0,
		})
		const { wrapped, waits } = retrying(provider)
		const failure = await collect(wrapped.chatStream(PARAMS)).catch((error: unknown) => error)
		expect(failure).toMatchObject({ kind: 'network' })
		expect(waits).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 32_000, 32_000, 32_000])
	})
})
