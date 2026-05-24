import { describe, expect, it, vi } from 'vitest'

import { ClawtoolMcpClient, McpProtocolError } from './mcp.js'

/** Build a Response stub that mimics clawtool's Streamable HTTP SSE shape. */
function sseResponse(body: object, sessionId?: string): Response {
	const headers = new Headers({ 'content-type': 'text/event-stream' })
	if (sessionId) headers.set('Mcp-Session-Id', sessionId)
	const text = `data: ${JSON.stringify(body)}\n\n`
	return new Response(text, { status: 200, headers })
}

function jsonResponse(body: object, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

describe('ClawtoolMcpClient', () => {
	it('initialize → tools/list issues the right wire calls and threads the session id', async () => {
		const fetchMock = vi.fn<typeof fetch>()
		// 1: initialize
		fetchMock.mockResolvedValueOnce(
			sseResponse(
				{
					jsonrpc: '2.0',
					id: 1,
					result: {
						protocolVersion: '2024-11-05',
						capabilities: {},
						serverInfo: { name: 'clawtool', version: '0.0.0' },
					},
				},
				'sid-xyz',
			),
		)
		// 2: notifications/initialized (no body matters)
		fetchMock.mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0' }))
		// 3: tools/list
		fetchMock.mockResolvedValueOnce(
			sseResponse({
				jsonrpc: '2.0',
				id: 2,
				result: { tools: [{ name: 'Bash', description: 'shell', inputSchema: {} }] },
			}),
		)
		const client = new ClawtoolMcpClient({
			endpoint: 'http://localhost:1234',
			token: 'tok',
			fetch: fetchMock,
		})
		const tools = await client.listTools()
		expect(tools).toEqual([{ name: 'Bash', description: 'shell', inputSchema: {} }])

		// All three calls hit /mcp.
		expect(fetchMock).toHaveBeenCalledTimes(3)
		for (const call of fetchMock.mock.calls) {
			expect(call[0]).toBe('http://localhost:1234/mcp')
		}
		// Initialize carried the bearer + method headers, no session id yet.
		const initHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>
		expect(initHeaders.Authorization).toBe('Bearer tok')
		expect(initHeaders['Mcp-Method']).toBe('initialize')
		expect(initHeaders['Mcp-Session-Id']).toBeUndefined()
		// Subsequent calls echo the session id captured from the initialize response.
		const notifyHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>
		expect(notifyHeaders['Mcp-Session-Id']).toBe('sid-xyz')
		const listHeaders = fetchMock.mock.calls[2]?.[1]?.headers as Record<string, string>
		expect(listHeaders['Mcp-Session-Id']).toBe('sid-xyz')
		expect(listHeaders['Mcp-Method']).toBe('tools/list')
	})

	it('omits the Authorization header when the token is empty (no-auth daemon)', async () => {
		const fetchMock = vi.fn<typeof fetch>()
		fetchMock.mockResolvedValue(
			sseResponse(
				{
					jsonrpc: '2.0',
					id: 1,
					result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: {} },
				},
				'sid-noauth',
			),
		)
		const client = new ClawtoolMcpClient({
			endpoint: 'http://localhost:1234',
			token: '',
			fetch: fetchMock,
		})
		await client.initialize()
		const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>
		expect(headers.Authorization).toBeUndefined()
	})

	it('tools/call adds the Mcp-Name header for the tool dispatch', async () => {
		const fetchMock = vi.fn<typeof fetch>()
		fetchMock.mockResolvedValueOnce(
			sseResponse(
				{
					jsonrpc: '2.0',
					id: 1,
					result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: {} },
				},
				'sid-call',
			),
		)
		fetchMock.mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0' }))
		fetchMock.mockResolvedValueOnce(
			sseResponse({
				jsonrpc: '2.0',
				id: 2,
				result: { content: [{ type: 'text', text: 'ok' }] },
			}),
		)
		const client = new ClawtoolMcpClient({
			endpoint: 'http://localhost:1234',
			token: 'tok',
			fetch: fetchMock,
		})
		const result = await client.callTool('Bash', { command: 'echo hi' })
		expect(result.content[0]).toEqual({ type: 'text', text: 'ok' })
		const callHeaders = fetchMock.mock.calls[2]?.[1]?.headers as Record<string, string>
		expect(callHeaders['Mcp-Name']).toBe('Bash')
	})

	it('throws McpProtocolError on non-2xx responses', async () => {
		const fetchMock = vi.fn<typeof fetch>()
		fetchMock.mockResolvedValue(new Response('', { status: 404 }))
		const client = new ClawtoolMcpClient({
			endpoint: 'http://localhost:1234',
			token: '',
			fetch: fetchMock,
		})
		await expect(client.initialize()).rejects.toThrow(McpProtocolError)
	})

	it('throws McpProtocolError when the envelope reports a JSON-RPC error', async () => {
		const fetchMock = vi.fn<typeof fetch>()
		fetchMock.mockResolvedValueOnce(
			sseResponse({
				jsonrpc: '2.0',
				id: 1,
				error: { code: -32601, message: 'method not found' },
			}),
		)
		const client = new ClawtoolMcpClient({
			endpoint: 'http://localhost:1234',
			token: '',
			fetch: fetchMock,
		})
		await expect(client.initialize()).rejects.toThrow(/method not found/)
	})
})
