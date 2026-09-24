import { describe, expect, it } from 'vitest'
import { McpProtocolError, McpStdioClient, McpToolError } from '../adapters/cua-driver/client.js'
import { SpawnError } from '../util/spawn.js'
import { type FakeServerScript, fakeSpawner, toolResult } from './fake-mcp-process.js'

function client(script: FakeServerScript | ((index: number) => FakeServerScript), extra = {}) {
	const spawner = fakeSpawner(script)
	const instance = new McpStdioClient({
		command: 'cua-driver.exe',
		args: ['mcp'],
		spawnProcess: spawner.spawnProcess,
		requestTimeoutMs: 1_000,
		startTimeoutMs: 1_000,
		...extra,
	})
	return { client: instance, processes: spawner.processes }
}

describe('the stdio MCP client that keeps cua-driver running', () => {
	it('starts once, shakes hands, and reuses the process for every later call', async () => {
		const { client: mcp, processes } = client({
			tool: (call) => toolResult({ echoed: call.name }),
		})
		const first = await mcp.callTool('get_screen_size')
		const second = await mcp.callTool('get_cursor_position')
		expect(first.structuredContent).toEqual({ echoed: 'get_screen_size' })
		expect(second.structuredContent).toEqual({ echoed: 'get_cursor_position' })
		expect(processes).toHaveLength(1)
		expect(mcp.starts).toBe(1)
		const methods = processes[0]?.received.map((message) => message.method)
		expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/call', 'tools/call'])
		const init = processes[0]?.received[0] as { params: { protocolVersion: string } }
		expect(init.params.protocolVersion).toBe('2025-06-18')
		await mcp.dispose()
	})

	it('runs afterStart before the first caller request, on every started process', async () => {
		const { client: mcp, processes } = client(
			{ tool: () => toolResult({}) },
			{
				afterStart: async (
					call: (name: string, args?: Record<string, unknown>) => Promise<unknown>,
				) => {
					await call('set_agent_cursor_enabled', { enabled: false })
				},
			},
		)
		await mcp.callTool('click', { scope: 'desktop', x: 1, y: 2 })
		expect(processes[0]?.toolCalls.map((call) => call.name)).toEqual([
			'set_agent_cursor_enabled',
			'click',
		])
		await mcp.dispose()
	})

	it('routes answers by id, whatever order they arrive in', async () => {
		const held: Array<() => void> = []
		const { client: mcp } = client({
			tool: (call, process) => {
				// Answer "slow" only after "fast" has been answered.
				if (call.name === 'slow') {
					const request = process.received.find(
						(message) => (message.params as { name?: string } | undefined)?.name === 'slow',
					)
					held.push(() =>
						process.send({
							jsonrpc: '2.0',
							id: request?.id,
							result: { content: [], structuredContent: { who: 'slow' } },
						}),
					)
					return { hang: true }
				}
				setImmediate(() => held.shift()?.())
				return toolResult({ who: 'fast' })
			},
		})
		await mcp.start()
		const slow = mcp.callTool('slow')
		const fast = mcp.callTool('fast')
		expect((await fast).structuredContent).toEqual({ who: 'fast' })
		expect((await slow).structuredContent).toEqual({ who: 'slow' })
		await mcp.dispose()
	})

	it('carries Turkish text, quotes, backslashes and newlines through JSON exactly', async () => {
		const text = 'Merhaba dünya ığüşöçİ "quoted" \\back\\slash\nnew line\ttab {}+%^~ 😀'
		const { client: mcp, processes } = client({
			tool: (call) => toolResult({ text: call.arguments.text as string }),
		})
		const result = await mcp.callTool('type_text', { scope: 'desktop', text })
		expect(result.structuredContent?.text).toBe(text)
		expect(processes[0]?.toolCalls[0]?.arguments.text).toBe(text)
		await mcp.dispose()
	})

	it('reassembles a multi-megabyte line that arrives in small chunks', async () => {
		const data = Buffer.alloc(1_500_000, 7).toString('base64')
		const { client: mcp } = client({
			chunkBytes: 4_096,
			tool: () => ({
				result: {
					content: [{ type: 'image', data, mimeType: 'image/png' }],
					structuredContent: {},
				},
			}),
		})
		const result = await mcp.callTool('get_desktop_state')
		expect((result.content[0] as { data: string }).data).toBe(data)
		await mcp.dispose()
	})

	it('turns isError into McpToolError with the server’s words, and keeps the process', async () => {
		const { client: mcp, processes } = client({
			tool: (call) =>
				call.name === 'bring_to_front'
					? { result: { isError: true, content: [{ type: 'text', text: 'pid 9 has no window' }] } }
					: toolResult({ ok: true }),
		})
		const error = await mcp.callTool('bring_to_front', { pid: 9 }).catch((e: unknown) => e)
		expect(error).toBeInstanceOf(McpToolError)
		expect((error as Error).message).toBe('pid 9 has no window')
		expect(error).not.toBeInstanceOf(SpawnError)
		await mcp.callTool('get_screen_size')
		expect(processes).toHaveLength(1)
		await mcp.dispose()
	})

	it('turns a JSON-RPC error into McpProtocolError', async () => {
		const { client: mcp } = client({
			tool: () => ({ error: { code: -32602, message: 'bad params' } }),
		})
		const error = await mcp.callTool('click').catch((e: unknown) => e)
		expect(error).toBeInstanceOf(McpProtocolError)
		expect((error as McpProtocolError).code).toBe(-32602)
		await mcp.dispose()
	})

	it('answers a server ping and refuses other server requests instead of leaving them waiting', async () => {
		const { client: mcp, processes } = client({
			tool: (_call, process) => {
				process.send({ jsonrpc: '2.0', id: 'srv-1', method: 'ping' })
				process.send({ jsonrpc: '2.0', id: 'srv-2', method: 'sampling/createMessage', params: {} })
				process.send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } })
				process.write('not json at all\n')
				return toolResult({ fine: true })
			},
		})
		expect((await mcp.callTool('get_screen_size')).structuredContent).toEqual({ fine: true })
		await new Promise((resolve) => setImmediate(resolve))
		const replies = processes[0]?.received.filter((message) => typeof message.id === 'string')
		expect(replies).toEqual([
			{ jsonrpc: '2.0', id: 'srv-1', result: {} },
			{
				jsonrpc: '2.0',
				id: 'srv-2',
				error: { code: -32601, message: 'Method not found: sampling/createMessage' },
			},
		])
		await mcp.dispose()
	})

	it('kills a server that does not answer in time, reports the request as timed out, and restarts on the next call', async () => {
		const { client: mcp, processes } = client((index) => ({
			tool: (call) =>
				index === 0 && call.name === 'click' ? { hang: true } : toolResult({ index }),
		}))
		const error = await mcp.callTool('click', { scope: 'desktop' }, 50).catch((e: unknown) => e)
		expect(error).toBeInstanceOf(SpawnError)
		expect((error as SpawnError).result.timedOut).toBe(true)
		expect((error as Error).message).toMatch(/did not answer tools\/call in time/)
		expect(processes[0]?.signals).toEqual(['SIGKILL'])

		const after = await mcp.callTool('get_screen_size')
		expect(after.structuredContent).toEqual({ index: 1 })
		expect(mcp.starts).toBe(2)
		await mcp.dispose()
	})

	it('reports a request lost to a crash as a SpawnError with the exit code and stderr, then restarts', async () => {
		const { client: mcp, processes } = client((index) => ({
			tool: (_call, process) => {
				if (index === 0) {
					process.crash(3)
					return { hang: true }
				}
				return toolResult({ index })
			},
		}))
		const error = await mcp.callTool('drag').catch((e: unknown) => e)
		expect(error).toBeInstanceOf(SpawnError)
		expect((error as SpawnError).result).toMatchObject({ exitCode: 3, timedOut: false })
		expect((error as Error).message).toMatch(/exited \(code 3\).*boom: the driver fell over/s)
		expect((await mcp.callTool('get_screen_size')).structuredContent).toEqual({ index: 1 })
		expect(processes).toHaveLength(2)
		await mcp.dispose()
	})

	it('reports a failed start as an ordinary error: nothing was sent to the desktop', async () => {
		const { client: mcp } = client({ initialize: () => ({ exit: 9 }) })
		const error = await mcp.callTool('click').catch((e: unknown) => e)
		expect(error).toBeInstanceOf(Error)
		expect(error).not.toBeInstanceOf(SpawnError)
		expect((error as Error).message).toMatch(/cua-driver\.exe did not start/)
	})

	it('reports a start that hangs as an ordinary error and kills the process', async () => {
		const { client: mcp, processes } = client(
			{ initialize: () => ({ hang: true }) },
			{ startTimeoutMs: 50 },
		)
		const error = await mcp.callTool('click').catch((e: unknown) => e)
		expect(error).not.toBeInstanceOf(SpawnError)
		expect((error as Error).message).toMatch(/did not start/)
		expect(processes[0]?.signals).toEqual(['SIGKILL'])
	})

	it('shares one start between concurrent first calls', async () => {
		const { client: mcp, processes } = client({ tool: (call) => toolResult({ name: call.name }) })
		const results = await Promise.all([mcp.callTool('a'), mcp.callTool('b'), mcp.callTool('c')])
		expect(results.map((result) => result.structuredContent?.name)).toEqual(['a', 'b', 'c'])
		expect(processes).toHaveLength(1)
		await mcp.dispose()
	})

	it('asks the server to exit on dispose, and refuses calls afterwards', async () => {
		const { client: mcp, processes } = client({ tool: () => toolResult({}) })
		await mcp.callTool('get_screen_size')
		await mcp.dispose()
		expect(processes[0]?.exitCode).toBe(0)
		expect(processes[0]?.signals).toEqual([])
		await expect(mcp.callTool('get_screen_size')).rejects.toThrow(/disposed/)
	})

	it('kills a server that ignores the request to exit', async () => {
		const { client: mcp, processes } = client({ ignoreStdinEnd: true, tool: () => toolResult({}) })
		await mcp.callTool('get_screen_size')
		await mcp.dispose()
		expect(processes[0]?.signals).toEqual(['SIGKILL'])
	}, 10_000)

	it('fails a request in flight at dispose as stopped, not as a clean answer', async () => {
		const { client: mcp, processes } = client({ tool: () => ({ hang: true }) })
		await mcp.start()
		const pending = mcp.callTool('click').catch((e: unknown) => e)
		while ((processes[0]?.toolCalls.length ?? 0) === 0) {
			await new Promise((resolve) => setImmediate(resolve))
		}
		await mcp.dispose()
		const error = await pending
		expect(error).toBeInstanceOf(SpawnError)
		expect((error as Error).message).toMatch(/stopped before it answered/)
	})

	it('refuses a request that would reach a server already told to exit', async () => {
		const { client: mcp } = client({ tool: () => toolResult({}) })
		await mcp.start()
		const late = mcp.callTool('click').catch((e: unknown) => e)
		await mcp.dispose()
		const error = await late
		expect(error).not.toBeInstanceOf(SpawnError)
		expect((error as Error).message).toMatch(/disposed/)
	})
})
