import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MCPJsonRpcMessage } from '../../types/connector/index.js'
import { MCPClient } from './client.js'

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('Streamable HTTP MCP transport', () => {
	it('connects through MCPClient, preserves session headers, and parses SSE responses', async () => {
		const fetchMock = vi.fn<typeof fetch>()
		fetchMock
			.mockResolvedValueOnce(
				jsonResponse(
					{
						jsonrpc: '2.0',
						id: 1,
						result: {
							protocolVersion: '2024-11-05',
							capabilities: { tools: { listChanged: true } },
							serverInfo: { name: 'github' },
						},
					},
					{ 'mcp-session-id': 'sid_123' },
				),
			)
			.mockResolvedValueOnce(new Response('', { status: 202 }))
			.mockResolvedValueOnce(
				sseResponse([
					{ jsonrpc: '2.0', method: 'notifications/progress', params: { pct: 50 } },
					{
						jsonrpc: '2.0',
						id: 2,
						result: {
							tools: [
								{
									name: 'search_repositories',
									description: 'Search repositories',
									inputSchema: { type: 'object' },
								},
							],
						},
					},
				]),
			)
		vi.stubGlobal('fetch', fetchMock)

		const client = new MCPClient({
			serverName: 'github',
			transport: {
				type: 'streamable_http',
				url: 'https://mcp.example.test/mcp',
				headers: { Authorization: 'Bearer token' },
			},
		})
		const notifications: string[] = []
		client.onNotification((method) => notifications.push(method))

		await client.connect()
		const tools = await client.listTools()

		expect(tools.map((tool) => tool.name)).toEqual(['search_repositories'])
		expect(notifications).toEqual(['notifications/progress'])
		expect(fetchMock).toHaveBeenCalledTimes(3)

		const initialize = requestAt(fetchMock, 0)
		expect(initialize.input).toBe('https://mcp.example.test/mcp')
		expect(initialize.body.method).toBe('initialize')
		expect(initialize.headers.Authorization).toBe('Bearer token')
		expect(initialize.headers.Accept).toBe('application/json, text/event-stream')

		const initialized = requestAt(fetchMock, 1)
		expect(initialized.body.method).toBe('notifications/initialized')
		expect(initialized.headers['Mcp-Session-Id']).toBe('sid_123')

		const listTools = requestAt(fetchMock, 2)
		expect(listTools.body.method).toBe('tools/list')
		expect(listTools.headers['Mcp-Session-Id']).toBe('sid_123')
	})

	it('supports the streamable-http alias and sends tool-name hint headers', async () => {
		const fetchMock = vi.fn<typeof fetch>()
		fetchMock
			.mockResolvedValueOnce(
				jsonResponse(
					{
						jsonrpc: '2.0',
						id: 1,
						result: {
							protocolVersion: '2024-11-05',
							capabilities: { tools: {} },
							serverInfo: { name: 'linear' },
						},
					},
					{ 'Mcp-Session-Id': 'sid_alias' },
				),
			)
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValueOnce(
				jsonResponse({
					jsonrpc: '2.0',
					id: 2,
					result: { content: [{ type: 'text', text: 'ok' }] },
				}),
			)
		vi.stubGlobal('fetch', fetchMock)

		const client = new MCPClient({
			serverName: 'linear',
			transport: {
				type: 'streamable-http',
				url: 'https://mcp.example.test/linear',
			},
		})

		await client.connect()
		const result = await client.callTool('create_issue', { title: 'Bug' })

		expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
		const callTool = requestAt(fetchMock, 2)
		expect(callTool.body.method).toBe('tools/call')
		expect(callTool.headers['Mcp-Session-Id']).toBe('sid_alias')
		expect(callTool.headers['Mcp-Name']).toBe('create_issue')
	})
})

function jsonResponse(body: MCPJsonRpcMessage, headers?: Record<string, string>): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: {
			'content-type': 'application/json',
			...headers,
		},
	})
}

function sseResponse(messages: MCPJsonRpcMessage[]): Response {
	return new Response(messages.map((message) => `data: ${JSON.stringify(message)}\n\n`).join(''), {
		status: 200,
		headers: {
			'content-type': 'text/event-stream',
		},
	})
}

function requestAt(
	fetchMock: ReturnType<typeof vi.fn<typeof fetch>>,
	index: number,
): {
	input: Parameters<typeof fetch>[0]
	headers: Record<string, string>
	body: MCPJsonRpcMessage
} {
	const call = fetchMock.mock.calls[index]
	if (!call) {
		throw new Error(`No fetch call at index ${index}`)
	}
	const [input, init] = call
	if (!init) {
		throw new Error(`Fetch call at index ${index} had no init`)
	}
	const headers = init.headers as Record<string, string>
	const body = JSON.parse(String(init.body)) as MCPJsonRpcMessage
	return { input, headers, body }
}
