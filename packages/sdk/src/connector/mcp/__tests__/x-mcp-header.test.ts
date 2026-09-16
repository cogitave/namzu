import { describe, expect, it, vi } from 'vitest'

import { MCP_MODERN_VERSIONS } from '../../../constants/mcp/index.js'
import type {
	MCPJsonRpcMessage,
	MCPToolDefinition,
	MCPTransport,
	MCPTransportUnion,
} from '../../../types/connector/index.js'
import type { LogAttributes } from '../../../utils/log/index.js'
import type { Logger } from '../../../utils/logger.js'
import {
	discoverResult,
	jsonRpcResponse,
	jsonRpcStatusResponse,
	scriptedHttpOrigin,
	scriptedStdioServer,
	statusResponse,
} from '../__fixtures__/scripted-era-server.js'
import { MCPClient } from '../client.js'
import { createMcpEraCache } from '../era.js'
import { MCPHttpStatusError } from '../errors.js'

/**
 * `x-mcp-header`: which tool definitions this client will expose, and which
 * `Mcp-Param-*` headers a call carries.
 *
 * This is the first place namzu refuses something a server offered, so the
 * cases below are written from the operator's side of it: a refused tool is
 * gone from the roster and the reason is in the log, and one bad definition
 * never takes a good one with it.
 *
 * Every case uses a fresh era cache, for the reason the era suite does: a
 * case that passes because of the one before it proves nothing.
 */

const MODERN = MCP_MODERN_VERSIONS[0] as string
const URL = 'https://mcp.example.test/rpc'

/** A logger that keeps every `warn` body and bag, and swallows the rest. */
function recordingLogger(): { logger: Logger; warnings: [string, LogAttributes?][] } {
	const warnings: [string, LogAttributes?][] = []
	const sink = {
		debug: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		warn: (message: string, attributes?: LogAttributes) => {
			warnings.push([message, attributes])
		},
	}
	const logger = { ...sink, child: () => logger } as unknown as Logger
	return { logger, warnings }
}

/** The reasons a listing logged, one string per refused tool. */
function refusals(warnings: [string, LogAttributes?][]): string[] {
	return warnings
		.filter(([message]) => message.includes('invalid x-mcp-header'))
		.map(([, attributes]) => String(attributes?.['namzu.mcp.reason'] ?? ''))
}

/** The tool a refusal named. */
function refusedTools(warnings: [string, LogAttributes?][]): string[] {
	return warnings
		.filter(([message]) => message.includes('invalid x-mcp-header'))
		.map(([, attributes]) => String(attributes?.['namzu.mcp.tool'] ?? ''))
}

type ToolCallScript = (message: MCPJsonRpcMessage) => Response

/**
 * A modern origin that publishes `tools` and answers `tools/call` with
 * whatever the case scripts.
 *
 * `tools` is `unknown[]` on purpose: half these cases are definitions a
 * well-typed server could not produce, which is exactly the input the
 * validation exists for.
 */
function toolServer(
	tools: unknown[],
	onCall?: ToolCallScript,
): ReturnType<typeof scriptedHttpOrigin> {
	return scriptedHttpOrigin((call) => {
		const message = call.body
		if (message?.method === 'server/discover') {
			return jsonRpcResponse({
				jsonrpc: '2.0',
				id: message.id,
				result: discoverResult({
					supportedVersions: [MODERN],
					serverInfo: { name: 'header-fixture' },
				}),
			})
		}
		if (message?.method === 'tools/list') {
			return jsonRpcResponse({ jsonrpc: '2.0', id: message.id, result: { tools } })
		}
		if (onCall && message) return onCall(message)
		return jsonRpcResponse({
			jsonrpc: '2.0',
			id: message?.id,
			result: { content: [{ type: 'text', text: 'ok' }] },
		})
	})
}

/** A legacy origin: no `server/discover`, an `initialize` handshake instead. */
function legacyToolServer(tools: unknown[]): ReturnType<typeof scriptedHttpOrigin> {
	return scriptedHttpOrigin((call) => {
		const message = call.body
		if (message?.method === 'server/discover') return statusResponse(404, 'Not Found')
		if (message?.method === 'initialize') {
			return jsonRpcResponse({
				jsonrpc: '2.0',
				id: message.id,
				result: {
					protocolVersion: '2025-11-25',
					capabilities: {},
					serverInfo: { name: 'legacy-fixture' },
				},
			})
		}
		if (message?.method === 'notifications/initialized') return new Response(null, { status: 202 })
		if (message?.method === 'tools/list') {
			return jsonRpcResponse({ jsonrpc: '2.0', id: message.id, result: { tools } })
		}
		return jsonRpcResponse({
			jsonrpc: '2.0',
			id: message?.id,
			result: { content: [{ type: 'text', text: 'ok' }] },
		})
	})
}

function httpClient(origin: ReturnType<typeof scriptedHttpOrigin>, logger?: Logger): MCPClient {
	return new MCPClient({
		serverName: 'fixture',
		transport: { type: 'streamable-http', url: URL, fetch: origin.fetch },
		eraCache: createMcpEraCache(),
		...(logger ? { logger } : {}),
	})
}

/** Connect, list, and report what survived along with what was refused. */
async function listFrom(
	tools: unknown[],
): Promise<{ listed: MCPToolDefinition[]; warnings: [string, LogAttributes?][] }> {
	const { logger, warnings } = recordingLogger()
	const client = httpClient(toolServer(tools), logger)
	await client.connect()
	const listed = await client.listTools()
	return { listed, warnings }
}

/** The headers the origin saw on the one `tools/call` it received. */
function callHeaders(origin: ReturnType<typeof scriptedHttpOrigin>): Record<string, string> {
	const call = origin.calls.find((entry) => entry.body?.method === 'tools/call')
	return call?.headers ?? {}
}

/** The `execute_sql` tool from the spec's own worked example. */
const EXECUTE_SQL = {
	name: 'execute_sql',
	description: 'Execute SQL',
	inputSchema: {
		type: 'object',
		properties: {
			region: {
				type: 'string',
				description: 'The region to execute the query in',
				'x-mcp-header': 'Region',
			},
			query: { type: 'string', description: 'The SQL query to execute' },
		},
		required: ['region', 'query'],
	},
}

/** A one-parameter tool, annotated, for the encoding and type cases. */
function annotatedTool(type: string, headerName = 'Value'): Record<string, unknown> {
	return {
		name: 'mirror',
		inputSchema: {
			type: 'object',
			properties: { value: { type, 'x-mcp-header': headerName } },
		},
	}
}

describe('each of the six constraints refuses the tool that breaks it', () => {
	it('refuses an empty x-mcp-header', async () => {
		const { listed, warnings } = await listFrom([annotatedTool('string', '')])

		expect(listed).toEqual([])
		expect(refusals(warnings)[0]).toMatch(/is empty/)
		expect(refusedTools(warnings)).toEqual(['mirror'])
	})

	it('refuses a name that is not HTTP field-name token syntax', async () => {
		const { listed, warnings } = await listFrom([annotatedTool('string', 'Bad Header')])

		expect(listed).toEqual([])
		expect(refusals(warnings)[0]).toMatch(/token syntax/)
	})

	it('refuses a name carrying a carriage return or line feed', async () => {
		// The constraint with teeth: a field name ending mid-value would let
		// a server's own tool definition write a header this client never
		// agreed to send.
		const { listed, warnings } = await listFrom([annotatedTool('string', 'Region\r\nX-Evil: 1')])

		expect(listed).toEqual([])
		expect(refusals(warnings)[0]).toMatch(/carriage return or line feed/)
	})

	it('refuses two names that collide without regard to case', async () => {
		const { listed, warnings } = await listFrom([
			{
				name: 'mirror',
				inputSchema: {
					type: 'object',
					properties: {
						a: { type: 'string', 'x-mcp-header': 'Region' },
						b: { type: 'string', 'x-mcp-header': 'region' },
					},
				},
			},
		])

		expect(listed).toEqual([])
		expect(refusals(warnings)[0]).toMatch(/repeats/)
	})

	it('refuses a `number` parameter, and accepts the three primitives that are permitted', async () => {
		const refused = await listFrom([annotatedTool('number')])

		expect(refused.listed).toEqual([])
		expect(refusals(refused.warnings)[0]).toMatch(/`number` is excluded/)

		for (const type of ['string', 'boolean', 'integer']) {
			const admitted = await listFrom([annotatedTool(type)])

			expect(admitted.listed).toHaveLength(1)
		}
	})

	it('refuses an annotation reached through anything but `properties`', async () => {
		// One case per forbidden step. `$ref` is the subtle one: resolving
		// references before walking would make the annotation under `$defs`
		// look like an ordinary property and admit the tool.
		// The `if`/`then` schema is ASSEMBLED through a named key rather than
		// written inline: an object that carries a literal `then` is a
		// thenable trap anywhere it might be awaited, and the linter refuses
		// one on sight. The JSON Schema keyword is still exactly `then`.
		const CONDITIONAL_BRANCH = 'then'
		const ifThen: Record<string, unknown> = {
			type: 'object',
			properties: { flag: { type: 'boolean' } },
		}
		ifThen[CONDITIONAL_BRANCH] = { type: 'string', 'x-mcp-header': 'Then' }

		const elsewhere: [string, Record<string, unknown>][] = [
			[
				'items',
				{
					type: 'object',
					properties: {
						rows: { type: 'array', items: { type: 'string', 'x-mcp-header': 'Row' } },
					},
				},
			],
			[
				'properties under items',
				{
					type: 'object',
					properties: {
						rows: {
							type: 'array',
							items: {
								type: 'object',
								properties: { region: { type: 'string', 'x-mcp-header': 'Region' } },
							},
						},
					},
				},
			],
			[
				'oneOf',
				{
					type: 'object',
					properties: {
						choice: { oneOf: [{ type: 'string', 'x-mcp-header': 'Choice' }, { type: 'null' }] },
					},
				},
			],
			['if/then', ifThen],
			[
				'$ref',
				{
					type: 'object',
					properties: { region: { $ref: '#/$defs/Region' } },
					$defs: { Region: { type: 'string', 'x-mcp-header': 'Region' } },
				},
			],
			['the schema root', { type: 'object', properties: {}, 'x-mcp-header': 'Root' }],
		]

		for (const [where, inputSchema] of elsewhere) {
			const { listed, warnings } = await listFrom([{ name: 'mirror', inputSchema }])

			expect(listed, where).toEqual([])
			expect(refusals(warnings)[0], where).toMatch(/not statically reachable/)
		}
	})

	it('refuses an annotation that is not a string at all', async () => {
		const { listed, warnings } = await listFrom([
			{
				name: 'mirror',
				inputSchema: {
					type: 'object',
					properties: { value: { type: 'string', 'x-mcp-header': 7 } },
				},
			},
		])

		expect(listed).toEqual([])
		expect(refusals(warnings)[0]).toMatch(/not a string/)
	})
})

describe('one malformed definition does not deny the others', () => {
	it('returns the two valid tools out of three', async () => {
		const { listed, warnings } = await listFrom([
			{ name: 'alpha', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } },
			{
				name: 'broken',
				inputSchema: {
					type: 'object',
					properties: { b: { type: 'string', 'x-mcp-header': 'Bad Header' } },
				},
			},
			EXECUTE_SQL,
		])

		expect(listed.map((tool) => tool.name)).toEqual(['alpha', 'execute_sql'])
		expect(refusedTools(warnings)).toEqual(['broken'])
	})

	it('admits a tool with no annotations at all, unchanged', async () => {
		const plain = {
			name: 'plain',
			inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
		}
		const { listed, warnings } = await listFrom([plain])

		expect(listed).toEqual([plain])
		expect(refusals(warnings)).toEqual([])
	})

	it('does not read an example value as an annotation', async () => {
		// A `default` of `{"x-mcp-header": ...}` is an ordinary example value
		// for an object-typed parameter. Refusing the tool over it would be a
		// refusal invented by the walk rather than found in the schema.
		const { listed } = await listFrom([
			{
				name: 'mirror',
				inputSchema: {
					type: 'object',
					properties: { shape: { type: 'object', default: { 'x-mcp-header': 'Nope' } } },
				},
			},
		])

		expect(listed).toHaveLength(1)
	})

	it('does not read a parameter NAMED x-mcp-header as an annotation', async () => {
		const { listed } = await listFrom([
			{
				name: 'mirror',
				inputSchema: { type: 'object', properties: { 'x-mcp-header': { type: 'string' } } },
			},
		])

		expect(listed).toHaveLength(1)
	})
})

describe('a call mirrors its arguments into Mcp-Param-* headers', () => {
	it('produces the spec worked example, Mcp-Param-Region: us-west1', async () => {
		const origin = toolServer([EXECUTE_SQL])
		const client = httpClient(origin)
		await client.connect()
		await client.listTools()

		await client.callTool('execute_sql', { region: 'us-west1', query: 'SELECT * FROM users' })

		expect(callHeaders(origin)).toMatchObject({
			'MCP-Protocol-Version': MODERN,
			'Mcp-Method': 'tools/call',
			'Mcp-Name': 'execute_sql',
			'Mcp-Param-Region': 'us-west1',
		})
	})

	it('reads a nested parameter at its exact property path', async () => {
		const origin = toolServer([
			{
				name: 'mirror',
				inputSchema: {
					type: 'object',
					properties: {
						filter: {
							type: 'object',
							properties: { region: { type: 'string', 'x-mcp-header': 'Region' } },
						},
					},
				},
			},
		])
		const client = httpClient(origin)
		await client.connect()
		await client.listTools()

		await client.callTool('mirror', { filter: { region: 'eu-west2' } })

		expect(callHeaders(origin)['Mcp-Param-Region']).toBe('eu-west2')
	})

	it('writes a boolean as lowercase true/false and an integer as a decimal string', async () => {
		const cases: [string, unknown, string][] = [
			['boolean', true, 'true'],
			['boolean', false, 'false'],
			['integer', 42, '42'],
			['integer', -7, '-7'],
			['integer', 0, '0'],
		]

		for (const [type, value, expected] of cases) {
			const origin = toolServer([annotatedTool(type)])
			const client = httpClient(origin)
			await client.connect()
			await client.listTools()

			await client.callTool('mirror', { value })

			expect(callHeaders(origin)['Mcp-Param-Value'], `${type} ${String(value)}`).toBe(expected)
		}
	})

	it('encodes exactly as the spec table does, sentinel row included', async () => {
		const rows: [string, string][] = [
			['us-west1', 'us-west1'],
			['Hello, 世界', '=?base64?SGVsbG8sIOS4lueVjA==?='],
			[' padded ', '=?base64?IHBhZGRlZCA=?='],
			['line1\nline2', '=?base64?bGluZTEKbGluZTI=?='],
			// The self-referential row: a plain-ASCII value that READS as a
			// sentinel is wrapped anyway, so it survives as itself.
			['=?base64?literal?=', '=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?='],
		]

		for (const [value, encoded] of rows) {
			const origin = toolServer([annotatedTool('string')])
			const client = httpClient(origin)
			await client.connect()
			await client.listTools()

			await client.callTool('mirror', { value })

			expect(callHeaders(origin)['Mcp-Param-Value'], JSON.stringify(value)).toBe(encoded)
		}
	})

	it('omits the header for an absent, a null, and an unrepresentable value', async () => {
		const cases: [string, Record<string, unknown>][] = [
			['absent', {}],
			['null', { value: null }],
			// A server contradicting its own schema, and an integer outside
			// the range the spec bounds these to. Sending either would put a
			// header on the wire that disagrees with the body it mirrors.
			['wrong type', { value: 12 }],
			['unsafe integer', { value: Number.MAX_SAFE_INTEGER + 2 }],
		]

		for (const [label, args] of cases) {
			const type = label === 'unsafe integer' ? 'integer' : 'string'
			const origin = toolServer([annotatedTool(type)])
			const client = httpClient(origin)
			await client.connect()
			await client.listTools()

			await client.callTool('mirror', args)

			expect(Object.keys(callHeaders(origin)), label).not.toContain('Mcp-Param-Value')
		}
	})

	it('sends no Mcp-Param header for a tool that was never listed', async () => {
		// Bindings come from a listing this client actually read. A call made
		// without one carries no mirrored header rather than a guessed one.
		const origin = toolServer([EXECUTE_SQL])
		const client = httpClient(origin)
		await client.connect()

		await client.callTool('execute_sql', { region: 'us-west1' })

		expect(Object.keys(callHeaders(origin))).not.toContain('Mcp-Param-Region')
	})
})

describe('a -32020 is recovered from exactly once', () => {
	/** An origin that answers `tools/call` with HeaderMismatch `times` times. */
	function mismatching(times: number): ReturnType<typeof scriptedHttpOrigin> {
		let seen = 0
		return toolServer([EXECUTE_SQL], (message) => {
			seen++
			if (seen <= times) {
				return jsonRpcStatusResponse(400, message.id, {
					code: -32020,
					message: 'HeaderMismatch',
				})
			}
			return jsonRpcResponse({
				jsonrpc: '2.0',
				id: message.id,
				result: { content: [{ type: 'text', text: 'ok' }] },
			})
		})
	}

	it('re-lists the tools and retries the call once', async () => {
		const origin = mismatching(1)
		const client = httpClient(origin)
		await client.connect()
		await client.listTools()

		const result = await client.callTool('execute_sql', { region: 'us-west1' })

		expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] })
		expect(origin.methods()).toEqual([
			'server/discover',
			'tools/list',
			'tools/call',
			'tools/list',
			'tools/call',
		])
	})

	it('surfaces a second -32020 rather than looping', async () => {
		const origin = mismatching(Number.POSITIVE_INFINITY)
		const client = httpClient(origin)
		await client.connect()
		await client.listTools()

		// The spec has HeaderMismatch arrive as a `400` carrying the JSON-RPC
		// error in the body, so what surfaces is the HTTP failure — with the
		// body it carried, which is where the code the recovery keyed on is.
		const failure = await client
			.callTool('execute_sql', { region: 'us-west1' })
			.catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(MCPHttpStatusError)
		expect((failure as MCPHttpStatusError).status).toBe(400)
		expect((failure as MCPHttpStatusError).bodyText).toContain('-32020')
		expect(origin.methods().filter((method) => method === 'tools/call')).toHaveLength(2)
	})

	it('does not re-list for an ordinary tool error', async () => {
		const origin = toolServer([EXECUTE_SQL], (message) =>
			jsonRpcResponse({
				jsonrpc: '2.0',
				id: message.id,
				error: { code: -32602, message: 'Invalid params' },
			}),
		)
		const client = httpClient(origin)
		await client.connect()
		await client.listTools()

		await expect(client.callTool('execute_sql', { region: 'us-west1' })).rejects.toThrow(/-32602/)
		expect(origin.methods().filter((method) => method === 'tools/list')).toHaveLength(1)
	})
})

describe('a transport that does not mirror headers ignores the annotation entirely', () => {
	it('excludes nothing on stdio and sends no Mcp-Param header', async () => {
		const tools = [EXECUTE_SQL, annotatedTool('number'), annotatedTool('string', 'Bad Header')]
		const server = scriptedStdioServer((message) => {
			if (message.method === 'server/discover') {
				return {
					jsonrpc: '2.0',
					id: message.id,
					result: discoverResult({ supportedVersions: [MODERN] }),
				}
			}
			if (message.method === 'tools/list') {
				return { jsonrpc: '2.0', id: message.id, result: { tools } }
			}
			return { jsonrpc: '2.0', id: message.id, result: { content: [] } }
		})
		const client = new MCPClient({
			serverName: 'fixture',
			transport: { type: 'stdio', command: 'scripted-server' } as MCPTransportUnion,
			eraCache: createMcpEraCache(),
		})
		;(client as unknown as { transport: MCPTransport }).transport = server.transport
		await client.connect()

		const listed = await client.listTools()
		await client.callTool('execute_sql', { region: 'us-west1' })

		expect(listed).toHaveLength(3)
		const sentHeaders = server.sent.flatMap(({ options }) => Object.keys(options?.headers ?? {}))
		expect(sentHeaders.filter((name) => name.startsWith('Mcp-Param-'))).toEqual([])
	})

	it('validates on a legacy Streamable HTTP connection but mirrors nothing', async () => {
		// Validation follows the TRANSPORT, as the spec conditions it, so a
		// roster does not change shape the day the origin behind it stops
		// answering `initialize`. The headers still follow the ERA: a legacy
		// request carries none of the modern mirroring.
		const origin = legacyToolServer([EXECUTE_SQL, annotatedTool('number')])
		const client = httpClient(origin)
		await client.connect()

		const listed = await client.listTools()
		await client.callTool('execute_sql', { region: 'us-west1' })

		expect(listed.map((tool) => tool.name)).toEqual(['execute_sql'])
		expect(Object.keys(callHeaders(origin))).not.toContain('Mcp-Param-Region')
	})
})
