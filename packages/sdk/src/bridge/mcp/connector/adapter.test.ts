/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 2):
 *
 *   - `MCPConnectorBridge` wraps a `ConnectorManager` and exposes
 *     connector methods as MCP tools with a name pattern
 *     `<prefix>_<connectorId>_<methodName>`; prefix defaults to 'namzu'.
 *   - `listTools()` with no instanceId iterates
 *     `manager.listConnectedInstances()`; `listTools(instanceId)` uses
 *     `manager.getInstance(instanceId)` and filters Boolean (missing
 *     instance → empty output).
 *   - `listTools()` rebuilds `mappings` from scratch on each call.
 *   - Schema conversion via `zodToJsonSchema` is best-effort; on
 *     conversion failure the schema falls back to `{type: 'object'}`.
 *   - `getMappings()` returns a COPY (mutation of the returned array
 *     does not affect internal state).
 *   - `callTool(name, args)`:
 *     - Returns `{content: [text], isError: true}` for unknown tools.
 *     - On manager success, returns `{content: [text], isError: false}`
 *       with the output stringified if non-string.
 *     - On manager failure, returns `{content: [text with error],
 *       isError: true}`; falls back to 'Unknown error' when the
 *       manager error is undefined.
 *   - Method descriptions include the connector DEFINITION name
 *     bracketed (not the instance name): `[<def.name>] <method.description>`.
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { ConnectorManager } from '../../../manager/connector/lifecycle.js'
import type { ConnectorRegistry } from '../../../registry/connector/definitions.js'
import type {
	ConnectorDefinition,
	ConnectorExecuteResult,
	ConnectorInstance,
} from '../../../types/connector/index.js'
import type { ConnectorId, ConnectorInstanceId } from '../../../types/ids/index.js'

import { MCPConnectorBridge } from './adapter.js'

const CID = 'conn_http' as ConnectorId
const IID = 'ci_abc' as ConnectorInstanceId

function makeDefinition(overrides: Partial<ConnectorDefinition> = {}): ConnectorDefinition {
	return {
		id: CID,
		name: 'HTTP',
		description: 'HTTP connector',
		connectionType: 'http',
		configSchema: z.object({}),
		methods: [
			{
				name: 'request',
				description: 'make http request',
				inputSchema: z.object({ url: z.string() }),
			},
		],
		...overrides,
	}
}

function makeInstance(): ConnectorInstance {
	return {
		id: IID,
		connectorId: CID,
		config: { connectorId: CID, name: 'svc' },
		status: 'connected',
		createdAt: Date.now(),
	}
}

function makeManager(overrides: Partial<ConnectorManager> = {}): ConnectorManager {
	const def = makeDefinition()
	const registry = {
		get: vi.fn(() => def),
	} as unknown as ConnectorRegistry
	const instance = makeInstance()
	return {
		getInstance: vi.fn(() => instance),
		getRegistry: vi.fn(() => registry),
		listConnectedInstances: vi.fn(() => [instance]),
		execute: vi.fn<() => Promise<ConnectorExecuteResult>>(),
		...overrides,
	} as unknown as ConnectorManager
}

describe('MCPConnectorBridge.listTools', () => {
	it('builds one MCP tool per method per connected instance with default prefix namzu', () => {
		const bridge = new MCPConnectorBridge({ manager: makeManager() })
		const tools = bridge.listTools()
		expect(tools).toHaveLength(1)
		expect(tools[0]?.name).toBe(`namzu_${CID}_request`)
		expect(tools[0]?.description).toBe('[HTTP] make http request')
	})

	it('honors a custom prefix', () => {
		const bridge = new MCPConnectorBridge({ manager: makeManager(), prefix: 'acme' })
		expect(bridge.listTools()[0]?.name).toBe(`acme_${CID}_request`)
	})

	it('single-instance lookup via listTools(instanceId) uses getInstance; missing instance → empty', () => {
		const manager = makeManager({
			getInstance: vi.fn(() => undefined),
		} as unknown as Partial<ConnectorManager>)
		const bridge = new MCPConnectorBridge({ manager })
		expect(bridge.listTools(IID)).toEqual([])
	})

	it('mappings are rebuilt on every listTools() call (not appended)', () => {
		const bridge = new MCPConnectorBridge({ manager: makeManager() })
		bridge.listTools()
		bridge.listTools()
		expect(bridge.getMappings()).toHaveLength(1)
	})

	it('skips instances whose connectorId is missing in the registry', () => {
		const manager = makeManager({
			getRegistry: vi.fn(() => ({ get: vi.fn(() => undefined) }) as unknown as ConnectorRegistry),
		} as unknown as Partial<ConnectorManager>)
		const bridge = new MCPConnectorBridge({ manager })
		expect(bridge.listTools()).toEqual([])
	})

	it('getMappings returns a copy — external mutation does not leak', () => {
		const bridge = new MCPConnectorBridge({ manager: makeManager() })
		bridge.listTools()
		const copy = bridge.getMappings()
		copy.length = 0
		expect(bridge.getMappings()).toHaveLength(1)
	})

	it('schema conversion falls back to {type: object} when zodToJsonSchema throws', () => {
		const bad = makeDefinition({
			methods: [
				{
					name: 'broken',
					description: 'd',
					// Not a real zod type — intentionally misleads zodToJsonSchema.
					inputSchema: null as unknown as z.ZodType,
				},
			],
		})
		const manager = makeManager({
			getRegistry: vi.fn(() => ({ get: vi.fn(() => bad) }) as unknown as ConnectorRegistry),
		} as unknown as Partial<ConnectorManager>)
		const bridge = new MCPConnectorBridge({ manager })
		const tools = bridge.listTools()
		expect(tools[0]?.inputSchema).toEqual({ type: 'object' })
	})
})

describe('MCPConnectorBridge.callTool', () => {
	it('unknown tool → isError true + explanatory text', async () => {
		const bridge = new MCPConnectorBridge({ manager: makeManager() })
		const result = await bridge.callTool('nope')
		expect(result.isError).toBe(true)
		expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('nope') })
	})

	it('happy path — string output passes through as text', async () => {
		const manager = makeManager()
		vi.mocked(manager.execute).mockResolvedValueOnce({
			success: true,
			output: 'hello',
			durationMs: 5,
		})
		const bridge = new MCPConnectorBridge({ manager })
		bridge.listTools()
		const result = await bridge.callTool(`namzu_${CID}_request`, { url: 'x' })
		expect(result.isError).toBe(false)
		expect(result.content[0]).toEqual({ type: 'text', text: 'hello' })
	})

	it('non-string success output is JSON-stringified', async () => {
		const manager = makeManager()
		vi.mocked(manager.execute).mockResolvedValueOnce({
			success: true,
			output: { status: 200 },
			durationMs: 1,
		})
		const bridge = new MCPConnectorBridge({ manager })
		bridge.listTools()
		const result = await bridge.callTool(`namzu_${CID}_request`)
		expect(result.content[0]).toEqual({
			type: 'text',
			text: JSON.stringify({ status: 200 }, null, 2),
		})
	})

	it('manager failure → isError true with error text; falls back to "Unknown error" when error is undefined', async () => {
		const manager = makeManager()
		vi.mocked(manager.execute).mockResolvedValueOnce({
			success: false,
			output: undefined,
			durationMs: 1,
		})
		const bridge = new MCPConnectorBridge({ manager })
		bridge.listTools()
		const result = await bridge.callTool(`namzu_${CID}_request`)
		expect(result.isError).toBe(true)
		expect(result.content[0]).toEqual({ type: 'text', text: 'Unknown error' })
	})

	it('carries the explicit error message when manager provides one', async () => {
		const manager = makeManager()
		vi.mocked(manager.execute).mockResolvedValueOnce({
			success: false,
			output: undefined,
			durationMs: 1,
			error: 'timeout',
		})
		const bridge = new MCPConnectorBridge({ manager })
		bridge.listTools()
		const result = await bridge.callTool(`namzu_${CID}_request`)
		expect(result.content[0]).toEqual({ type: 'text', text: 'timeout' })
	})

	it('passes empty args through as {} when invoked without a second arg', async () => {
		const manager = makeManager()
		vi.mocked(manager.execute).mockResolvedValueOnce({
			success: true,
			output: 'ok',
			durationMs: 1,
		})
		const bridge = new MCPConnectorBridge({ manager })
		bridge.listTools()
		await bridge.callTool(`namzu_${CID}_request`)
		expect(manager.execute).toHaveBeenCalledWith(expect.objectContaining({ input: {} }))
	})
})
