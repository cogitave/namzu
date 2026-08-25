import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { MCPJsonRpcMessage, MCPToolDefinition } from '../../../types/connector/index.js'
import type { RunId } from '../../../types/ids/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { mcpToolToToolDefinition } from '../adapter.js'
import { MCPClient } from '../client.js'
import { HttpSseTransport } from '../http-sse.js'
import { StreamableHttpTransport } from '../streamable-http.js'

interface TestOrigin {
	readonly url: string
	readonly requests: Array<{
		readonly headers: IncomingMessage['headers']
		readonly body: string
	}>
	readonly server: Server
}

const origins: TestOrigin[] = []

afterEach(async () => {
	await Promise.all(origins.splice(0).map((origin) => closeOrigin(origin)))
})

describe('remote MCP requests remain at their configured endpoint', () => {
	it('does not repeat a Streamable HTTP POST or its credentials at a redirect target', async () => {
		const sink = await startOrigin((_request, response) => {
			response.writeHead(204).end()
		})
		const source = await startOrigin((_request, response) => {
			response.writeHead(307, { Location: `${sink.url}/collect` }).end()
		})
		const transport = new StreamableHttpTransport({
			type: 'streamable-http',
			url: `${source.url}/rpc`,
			headers: { 'X-API-Key': 'mcp-secret' },
		})
		await transport.connect()
		const message: MCPJsonRpcMessage = {
			jsonrpc: '2.0',
			id: 7,
			method: 'tools/call',
			params: { name: 'write_record', arguments: { value: 'model-authored' } },
		}

		await expect(transport.send(message)).rejects.toThrow(
			/configure the final MCP endpoint directly/i,
		)

		expect(source.requests).toHaveLength(1)
		expect(source.requests[0]?.headers['x-api-key']).toBe('mcp-secret')
		expect(source.requests[0]?.body).toContain('model-authored')
		expect(sink.requests).toEqual([])
		await transport.close()
	})

	it('does not move the HTTP-SSE event stream or its credentials to a redirect target', async () => {
		const sink = await startOrigin((_request, response) => {
			response.writeHead(200, { 'Content-Type': 'text/event-stream' })
			response.write(': held open\n\n')
		})
		const source = await startOrigin((_request, response) => {
			response.writeHead(302, { Location: `${sink.url}/events` }).end()
		})
		const transport = new HttpSseTransport({
			type: 'http-sse',
			url: source.url,
			headers: { Authorization: 'Bearer mcp-secret' },
		})
		let reportError!: (error: Error) => void
		const reported = new Promise<Error>((resolve) => {
			reportError = resolve
		})
		transport.onError(reportError)

		await transport.connect()
		const error = await Promise.race([
			reported,
			new Promise<never>((_resolve, reject) => {
				setTimeout(() => reject(new Error('redirect refusal was not reported')), 500)
			}),
		])

		expect(error.message).toMatch(/configure the final MCP endpoint directly/i)
		expect(source.requests).toHaveLength(1)
		expect(source.requests[0]?.headers.authorization).toBe('Bearer mcp-secret')
		expect(sink.requests).toEqual([])
		await transport.close()
	})

	it('does not repeat an HTTP-SSE message POST at a redirect target', async () => {
		const sink = await startOrigin((_request, response) => {
			response.writeHead(204).end()
		})
		const source = await startOrigin((request, response) => {
			if (request.url === '/sse') {
				response.writeHead(200, { 'Content-Type': 'text/event-stream' })
				response.write(': ready\n\n')
				return
			}
			response.writeHead(307, { Location: `${sink.url}/collect` }).end()
		})
		const transport = new HttpSseTransport({
			type: 'http-sse',
			url: source.url,
			headers: { Authorization: 'Bearer mcp-secret' },
		})
		await transport.connect()
		const message: MCPJsonRpcMessage = {
			jsonrpc: '2.0',
			id: 8,
			method: 'tools/call',
			params: { name: 'write_record', arguments: { value: 'model-authored' } },
		}

		await expect(transport.send(message)).rejects.toThrow(
			/configure the final MCP endpoint directly/i,
		)

		expect(source.requests).toHaveLength(2)
		expect(source.requests[1]?.headers.authorization).toBe('Bearer mcp-secret')
		expect(source.requests[1]?.body).toContain('model-authored')
		expect(sink.requests).toEqual([])
		await transport.close()
	})

	it('reports a redirected mutating tool call as an unknown remote outcome', async () => {
		let remoteSideEffects = 0
		const sink = await startOrigin(async (_request, response, body) => {
			const message = JSON.parse(body) as MCPJsonRpcMessage
			respondJson(response, {
				jsonrpc: '2.0',
				id: message.id,
				result: { content: [{ type: 'text', text: 'redirect target answered' }] },
			})
		})
		const source = await startOrigin(async (_request, response, body) => {
			const message = JSON.parse(body) as MCPJsonRpcMessage
			if (message.method === 'initialize') {
				respondJson(response, {
					jsonrpc: '2.0',
					id: message.id,
					result: {
						protocolVersion: '2024-11-05',
						capabilities: { tools: {} },
						serverInfo: { name: 'redirecting-fixture', version: '1' },
					},
				})
				return
			}
			if (message.method === 'notifications/initialized') {
				response.writeHead(202).end()
				return
			}
			remoteSideEffects++
			response.writeHead(307, { Location: `${sink.url}/collect` }).end()
		})
		const client = new MCPClient({
			serverName: 'redirecting-fixture',
			transport: {
				type: 'streamable-http',
				url: `${source.url}/rpc`,
				headers: { Authorization: 'Bearer mcp-secret' },
			},
		})
		await client.connect()
		const remoteTool: MCPToolDefinition = {
			name: 'write_record',
			description: 'Mutate a remote record',
			inputSchema: {
				type: 'object',
				properties: { value: { type: 'string' } },
				required: ['value'],
			},
			annotations: { destructiveHint: true },
		}
		const definition = mcpToolToToolDefinition(remoteTool, client, 'fixture')
		const registry = new ToolRegistry()
		registry.register(definition)

		const result = await registry.execute(
			definition.name,
			{ value: 'one mutation only' },
			toolContext(),
		)

		expect(remoteSideEffects).toBe(1)
		expect(sink.requests).toEqual([])
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/remote outcome is unknown; do not automatically retry/i)
		expect(result.data).toEqual({
			code: 'mcp_tool_outcome_unknown',
			server: 'fixture',
			tool: 'write_record',
			outcome: 'unknown',
			retrySafety: 'unsafe',
		})
		await client.disconnect()
	})
})

async function startOrigin(
	handler: (
		request: IncomingMessage,
		response: ServerResponse,
		body: string,
	) => void | Promise<void>,
): Promise<TestOrigin> {
	const requests: TestOrigin['requests'] = []
	const server = createServer(async (request, response) => {
		let body = ''
		for await (const chunk of request) body += String(chunk)
		requests.push({ headers: { ...request.headers }, body })
		await handler(request, response, body)
	})
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject)
			resolve()
		})
	})
	const address = server.address() as AddressInfo
	const origin = { url: `http://127.0.0.1:${address.port}`, requests, server }
	origins.push(origin)
	return origin
}

async function closeOrigin(origin: TestOrigin): Promise<void> {
	origin.server.closeAllConnections()
	await new Promise<void>((resolve) => origin.server.close(() => resolve()))
}

function respondJson(response: ServerResponse, message: MCPJsonRpcMessage): void {
	response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(message))
}

function toolContext(): ToolContext {
	return {
		runId: 'run_mcp_redirect' as RunId,
		workingDirectory: '/',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}
