/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 2):
 *
 *   - `connectorMethodToTool(connectorId, instanceId, method, manager)`
 *     produces a `ToolDefinition` with:
 *     - `name: '<connectorId>_<methodName>'`
 *     - `description: '[<connectorId>] <method.description>'`
 *     - `category: 'network'`, `permissions: ['network_access']`,
 *       all read/destructive/concurrency flags set (readOnly:false,
 *       destructive:false, concurrencySafe:true) — current behavior,
 *       regardless of what the underlying method actually does.
 *     - `execute(input, ctx)` calls `manager.execute` and wraps the
 *       result; output is JSON-stringified on success, empty string
 *       on failure; `_context` is ignored (§2.7).
 *   - `connectorInstanceToTools(instanceId, manager)` throws when the
 *     instance is missing; returns one tool per method otherwise.
 *   - `allConnectorTools(manager)` enumerates
 *     `manager.listConnectedInstances()` and flattens per-instance tool
 *     lists.
 *   - `createConnectorRouterTool(manager)` returns a single
 *     `connector_execute` tool that routes by
 *     `{connectorId, instanceId, method, input}`; returns
 *     `{success: false}` results (not thrown errors) for missing
 *     instance or connectorId mismatch. The description enumerates
 *     currently connected instances.
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
import type { ToolContext } from '../../../types/tool/index.js'

import {
	allConnectorTools,
	connectorInstanceToTools,
	connectorMethodToTool,
	createConnectorRouterTool,
} from './adapter.js'

const CID = 'conn_http' as ConnectorId
const IID1 = 'ci_abc123' as ConnectorInstanceId
const IID2 = 'ci_def456' as ConnectorInstanceId

function makeMethod(name: string, description = `${name} description`) {
	return { name, description, inputSchema: z.object({}) }
}

function makeManager(overrides: Partial<ConnectorManager> = {}): ConnectorManager {
	const execute = vi.fn<() => Promise<ConnectorExecuteResult>>()
	const def: ConnectorDefinition = {
		id: CID,
		name: 'HTTP',
		description: 'HTTP connector',
		connectionType: 'http',
		configSchema: z.object({}),
		methods: [makeMethod('request'), makeMethod('send')],
	}
	const registry = {
		getOrThrow: vi.fn(() => def),
		get: vi.fn(() => def),
	} as unknown as ConnectorRegistry
	const instance: ConnectorInstance = {
		id: IID1,
		connectorId: CID,
		config: { connectorId: CID, name: 'default' },
		status: 'connected',
		createdAt: Date.now(),
	}
	return {
		getInstance: vi.fn(() => instance),
		getRegistry: vi.fn(() => registry),
		listConnectedInstances: vi.fn(() => [instance]),
		listInstances: vi.fn(() => [instance]),
		execute,
		...overrides,
	} as unknown as ConnectorManager
}

const ctx: ToolContext = {} as ToolContext

describe('connectorMethodToTool', () => {
	it('produces the expected name + description + flags', () => {
		const manager = makeManager()
		const tool = connectorMethodToTool(CID, IID1, makeMethod('request'), manager)
		expect(tool.name).toBe(`${CID}_request`)
		expect(tool.description).toBe(`[${CID}] request description`)
		expect(tool.category).toBe('network')
		expect(tool.permissions).toEqual(['network_access'])
		expect(tool.isReadOnly?.({})).toBe(false)
		expect(tool.isDestructive?.({})).toBe(false)
		expect(tool.isConcurrencySafe?.({})).toBe(true)
	})

	it('execute wraps manager.execute success into a ToolResult with stringified output', async () => {
		const manager = makeManager()
		vi.mocked(manager.execute).mockResolvedValueOnce({
			success: true,
			output: { answer: 42 },
			durationMs: 10,
		})
		const tool = connectorMethodToTool(CID, IID1, makeMethod('request'), manager)
		const result = await tool.execute({}, ctx)
		expect(result.success).toBe(true)
		expect(result.output).toBe(JSON.stringify({ answer: 42 }, null, 2))
		expect(result.data).toEqual({ answer: 42 })
	})

	it('execute carries through failure, leaves output as empty string', async () => {
		const manager = makeManager()
		vi.mocked(manager.execute).mockResolvedValueOnce({
			success: false,
			output: undefined,
			durationMs: 5,
			error: 'boom',
		})
		const tool = connectorMethodToTool(CID, IID1, makeMethod('request'), manager)
		const result = await tool.execute({}, ctx)
		expect(result.success).toBe(false)
		expect(result.output).toBe('')
		expect(result.error).toBe('boom')
	})
})

describe('connectorInstanceToTools', () => {
	it('returns one tool per method on the definition', () => {
		const manager = makeManager()
		const tools = connectorInstanceToTools(IID1, manager)
		expect(tools.map((t) => t.name)).toEqual([`${CID}_request`, `${CID}_send`])
	})

	it('throws when the instance is not found', () => {
		const manager = makeManager({
			getInstance: vi.fn(() => undefined),
		} as unknown as Partial<ConnectorManager>)
		expect(() => connectorInstanceToTools(IID2, manager)).toThrow(/not found/)
	})
})

describe('allConnectorTools', () => {
	it('enumerates every connected instance', () => {
		const manager = makeManager()
		const tools = allConnectorTools(manager)
		expect(tools).toHaveLength(2)
		expect(manager.listConnectedInstances).toHaveBeenCalled()
	})

	it('returns empty array when no connected instances', () => {
		const manager = makeManager({
			listConnectedInstances: vi.fn(() => []),
		} as unknown as Partial<ConnectorManager>)
		expect(allConnectorTools(manager)).toEqual([])
	})
})

describe('createConnectorRouterTool', () => {
	it('returns a single connector_execute tool', () => {
		const tool = createConnectorRouterTool(makeManager())
		expect(tool.name).toBe('connector_execute')
		expect(tool.category).toBe('network')
	})

	it('description enumerates currently connected instances', () => {
		const tool = createConnectorRouterTool(makeManager())
		expect(tool.description).toContain(CID)
		expect(tool.description).toContain(IID1)
		expect(tool.description).toContain('request')
	})

	it('description notes "No connectors are currently connected" when empty', () => {
		const manager = makeManager({
			listConnectedInstances: vi.fn(() => []),
		} as unknown as Partial<ConnectorManager>)
		const tool = createConnectorRouterTool(manager)
		expect(tool.description).toContain('No connectors are currently connected')
	})

	it('execute returns {success: false} when instance is missing', async () => {
		const manager = makeManager({
			getInstance: vi.fn(() => undefined),
		} as unknown as Partial<ConnectorManager>)
		const tool = createConnectorRouterTool(manager)
		const result = await tool.execute(
			{ connectorId: CID, instanceId: IID2, method: 'request', input: {} },
			ctx,
		)
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/not found/)
	})

	it('execute returns {success: false} when connectorId mismatches the instance', async () => {
		const manager = makeManager()
		const tool = createConnectorRouterTool(manager)
		const result = await tool.execute(
			{ connectorId: 'conn_other' as ConnectorId, instanceId: IID1, method: 'request', input: {} },
			ctx,
		)
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/belongs to connector/)
	})

	it('execute delegates to manager.execute on happy path', async () => {
		const manager = makeManager()
		vi.mocked(manager.execute).mockResolvedValueOnce({
			success: true,
			output: 'hello',
			durationMs: 1,
		})
		const tool = createConnectorRouterTool(manager)
		const result = await tool.execute(
			{ connectorId: CID, instanceId: IID1, method: 'request', input: { k: 'v' } },
			ctx,
		)
		expect(result.success).toBe(true)
		expect(result.data).toBe('hello')
	})
})
