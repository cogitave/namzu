import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MCPProgressUpdate } from '../../../types/connector/index.js'
import { type FakeHandler, clientFor, fakeMcpServer } from '../__fixtures__/fake-mcp-server.js'
import { buildEnvelope } from '../envelope.js'
import { MCPInputRequiredError, MCPProtocolError } from '../errors.js'

const EXT = 'io.modelcontextprotocol/tasks'
const CLIENT_CAPS = 'io.modelcontextprotocol/clientCapabilities'
const TASK = {
	taskId: 'T1',
	createdAt: '2026-11-12T00:00:00Z',
	lastUpdatedAt: '2026-11-12T00:00:00Z',
	ttlMs: 60_000,
	pollIntervalMs: 200,
}
const created = { resultType: 'task', status: 'working', ...TASK }
const toolResult = { resultType: 'complete', content: [{ type: 'text', text: 'done' }] }

/** `tasks/get` answers from a script, the last one repeating. */
function script(...states: Array<Record<string, unknown>>): FakeHandler {
	let i = 0
	return () => ({
		result: {
			resultType: 'complete',
			...TASK,
			...(states[Math.min(i++, states.length - 1)] ?? {}),
		},
	})
}

function taskServer(get: FakeHandler, advertise = true) {
	return fakeMcpServer({
		revision: 'newest',
		capabilities: advertise ? { extensions: { [EXT]: {} } } : {},
		handlers: {
			'tools/call': () => ({ result: created }),
			'tasks/get': get,
			'tasks/cancel': () => ({ result: { resultType: 'complete' } }),
		},
	})
}

describe('the tasks extension', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('awaits a task to its result, polling at the suggested interval', async () => {
		const server = taskServer(
			script(
				{ status: 'working' },
				{ status: 'working' },
				{ status: 'completed', result: toolResult },
			),
		)
		const client = clientFor(server)
		await client.connect()
		const call = client.callTool('slow', {})
		await vi.advanceTimersByTimeAsync(199)
		expect(server.requestsFor('tasks/get')).toHaveLength(0)
		await vi.advanceTimersByTimeAsync(1)
		expect(server.requestsFor('tasks/get')).toHaveLength(1)
		await vi.advanceTimersByTimeAsync(400)
		expect(await call).toEqual(toolResult)
		expect(server.requestsFor('tasks/get').map((m) => m.params?.taskId)).toEqual(['T1', 'T1', 'T1'])
		// The declaration rides on every request, the tool call included.
		const meta = server.requestsFor('tools/call')[0]?.params?._meta as Record<string, unknown>
		expect(meta[CLIENT_CAPS]).toEqual({ extensions: { [EXT]: {} } })
		await client.disconnect()
	})

	it('reports each change of status or message the way a progress notification does', async () => {
		const server = taskServer(
			script(
				{ status: 'working', statusMessage: 'queued' },
				{ status: 'working', statusMessage: 'queued' },
				{ status: 'working', statusMessage: 'half way', lastUpdatedAt: '2026-11-12T00:00:05Z' },
				{ status: 'completed', result: toolResult },
			),
		)
		const client = clientFor(server)
		await client.connect()
		const updates: MCPProgressUpdate[] = []
		const call = client.callTool('slow', {}, { onProgress: (u) => updates.push(u) })
		await vi.advanceTimersByTimeAsync(1_000)
		await call
		const messages = updates.map((u) => u.message)
		expect(messages).toEqual([undefined, 'queued', 'half way', undefined])
		expect(updates.map((u) => u.progress)).toEqual([1, 2, 3, 4])
		await client.disconnect()
	})

	it('cancels the task with tasks/cancel when the caller stops, and never with notifications/cancelled', async () => {
		const server = taskServer(script({ status: 'working' }))
		const client = clientFor(server)
		await client.connect()
		const controller = new AbortController()
		const call = client.callTool('slow', {}, { signal: controller.signal })
		const outcome = expect(call).rejects.toThrow('turn cancelled')
		await vi.advanceTimersByTimeAsync(50)
		controller.abort(new Error('turn cancelled'))
		await outcome
		expect(server.requestsFor('tasks/cancel').map((m) => m.params?.taskId)).toEqual(['T1'])
		expect(server.methods()).not.toContain('notifications/cancelled')
		await client.disconnect()
	})

	it('holds a call without progress to the request timeout, then cancels the task', async () => {
		const server = taskServer(script({ status: 'working' }))
		const client = clientFor(server, { requestTimeoutMs: 5_000 })
		await client.connect()
		const call = client.callTool('slow', {})
		const outcome = expect(call).rejects.toThrow(/timed out/)
		await vi.advanceTimersByTimeAsync(5_200)
		await outcome
		expect(server.requestsFor('tasks/cancel')).toHaveLength(1)
		await client.disconnect()
	})

	it('renews the deadline on each change when the client extends on progress, up to the total cap', async () => {
		let n = 0
		const server = taskServer(() => ({
			result: {
				resultType: 'complete',
				...TASK,
				status: 'working',
				statusMessage: `step ${++n}`,
				pollIntervalMs: 1_000,
			},
		}))
		const client = clientFor(server, {
			requestTimeoutMs: 5_000,
			resetTimeoutOnProgress: true,
			maxTotalTimeoutMs: 20_000,
		})
		await client.connect()
		const call = client.callTool('slow', {}, { onProgress: () => {} })
		const outcome = expect(call).rejects.toThrow(/timed out after 2\d{4}ms|timed out after 20000ms/)
		// Far past the 5 s request timeout, still waiting because it keeps changing.
		await vi.advanceTimersByTimeAsync(15_000)
		expect(server.requestsFor('tasks/cancel')).toHaveLength(0)
		await vi.advanceTimersByTimeAsync(6_000)
		await outcome
		expect(server.requestsFor('tasks/cancel')).toHaveLength(1)
		await client.disconnect()
	})

	it('turns a failed task into the protocol error the server gave', async () => {
		const server = taskServer(
			script({ status: 'failed', error: { code: -32603, message: 'rate limit' } }),
		)
		const client = clientFor(server)
		await client.connect()
		const call = client.callTool('slow', {})
		const outcome = expect(call).rejects.toMatchObject({
			code: -32603,
			message: expect.stringContaining('rate limit'),
		})
		await vi.advanceTimersByTimeAsync(300)
		await outcome
		await expect(call).rejects.toBeInstanceOf(MCPProtocolError)
		expect(server.requestsFor('tasks/cancel')).toHaveLength(0)
		await client.disconnect()
	})

	it('ends a task the server cancelled', async () => {
		const server = taskServer(script({ status: 'cancelled' }))
		const client = clientFor(server)
		await client.connect()
		const call = client.callTool('slow', {})
		const outcome = expect(call).rejects.toThrow(/cancelled by the server/)
		await vi.advanceTimersByTimeAsync(300)
		await outcome
		await client.disconnect()
	})

	it('cancels a task that wants input it cannot give, with the typed error', async () => {
		const server = taskServer(
			script({
				status: 'input_required',
				inputRequests: { name: { method: 'elicitation/create', params: {} } },
			}),
		)
		const client = clientFor(server)
		await client.connect()
		const call = client.callTool('slow', {})
		const outcome = expect(call).rejects.toBeInstanceOf(MCPInputRequiredError)
		await vi.advanceTimersByTimeAsync(300)
		await outcome
		expect(server.requestsFor('tasks/cancel')).toHaveLength(1)
		await client.disconnect()
	})

	it('declares nothing, and polls nothing, when the server does not advertise the extension', async () => {
		const server = taskServer(script({ status: 'working' }), false)
		server.on('tools/call', () => ({ result: toolResult }))
		const client = clientFor(server)
		await client.connect()
		expect(await client.callTool('fast', {})).toEqual(toolResult)
		const meta = server.requestsFor('tools/call')[0]?.params?._meta as Record<string, unknown>
		expect(meta[CLIENT_CAPS]).toEqual({})
		await client.disconnect()
	})

	it('declares nothing when the host turned tasks off', async () => {
		const server = taskServer(script({ status: 'working' }))
		server.on('tools/call', () => ({ result: toolResult }))
		const client = clientFor(server, { tasks: false })
		await client.connect()
		await client.callTool('fast', {})
		const meta = server.requestsFor('tools/call')[0]?.params?._meta as Record<string, unknown>
		expect(meta[CLIENT_CAPS]).toEqual({})
		await client.disconnect()
	})

	it('is not used against a server of the previous revision, which answers a call at once', async () => {
		const server = fakeMcpServer({
			revision: 'previous',
			capabilities: { extensions: { [EXT]: {} } },
			handlers: { 'tools/call': () => ({ result: { content: [{ type: 'text', text: 'ok' }] } }) },
		})
		const client = clientFor(server)
		await client.connect()
		const result = await client.callTool('fast', {})
		expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
		expect(server.requestsFor('tools/call')[0]?.params?._meta).toBeUndefined()
		expect(server.methods()).not.toContain('tasks/get')
		await client.disconnect()
	})
})

describe('the Mcp-Name header on a task request', () => {
	it('is the task id on get, update and cancel', () => {
		for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
			const { headers } = buildEnvelope({
				era: { kind: 'modern', version: '2026-07-28' },
				method,
				params: { taskId: 'T1' },
			})
			expect(headers['Mcp-Name']).toBe('T1')
			expect(headers['Mcp-Method']).toBe(method)
		}
	})
})
