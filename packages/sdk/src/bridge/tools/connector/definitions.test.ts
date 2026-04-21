/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 2):
 *
 *   - `createConnectorExecuteTool(config)` returns a `defineTool`-wrapped
 *     tool named `connector_execute` that:
 *     - Returns `{success: false, error: '... not found'}` when instance
 *       is missing.
 *     - Returns `{success: false, error: '... not connected'}` when the
 *       instance exists but `status !== 'connected'`.
 *     - Returns `{success: false, error: ...}` when `manager.execute`
 *       itself reports failure; falls back to 'Connector execution
 *       failed' when the execute error is undefined.
 *     - On success, stringifies non-string outputs to JSON; strings pass
 *       through as-is.
 *     - Attaches `data: { durationMs, metadata }` on success.
 *   - `createConnectorListTool(config)` returns a tool named
 *     `connector_list` that:
 *     - Emits "No connector instances configured." when none exist.
 *     - Lists each instance with `- <id> (<connectorId>): <name> [<status>]`.
 *   - `createConnectorTools(config)` returns the pair of tools above.
 */

import { describe, expect, it, vi } from 'vitest'

import type { ConnectorManager } from '../../../manager/connector/lifecycle.js'
import type { ConnectorExecuteResult, ConnectorInstance } from '../../../types/connector/index.js'
import type { ConnectorId, ConnectorInstanceId } from '../../../types/ids/index.js'
import type { ToolContext } from '../../../types/tool/index.js'

import {
	createConnectorExecuteTool,
	createConnectorListTool,
	createConnectorTools,
} from './definitions.js'

const CID = 'conn_http' as ConnectorId
const IID = 'ci_abc123' as ConnectorInstanceId

function makeInstance(overrides: Partial<ConnectorInstance> = {}): ConnectorInstance {
	return {
		id: IID,
		connectorId: CID,
		config: { connectorId: CID, name: 'default' },
		status: 'connected',
		createdAt: Date.now(),
		...overrides,
	}
}

function makeManager(overrides: Partial<ConnectorManager> = {}): ConnectorManager {
	return {
		getInstance: vi.fn(() => makeInstance()),
		listInstances: vi.fn(() => [makeInstance()]),
		execute: vi.fn<() => Promise<ConnectorExecuteResult>>(),
		...overrides,
	} as unknown as ConnectorManager
}

const ctx: ToolContext = {} as ToolContext

describe('createConnectorExecuteTool', () => {
	it('is named connector_execute', () => {
		const tool = createConnectorExecuteTool({ manager: makeManager() })
		expect(tool.name).toBe('connector_execute')
	})

	it('returns error when instance is missing', async () => {
		const manager = makeManager({
			getInstance: vi.fn(() => undefined),
		} as unknown as Partial<ConnectorManager>)
		const tool = createConnectorExecuteTool({ manager })
		const result = await tool.execute({ instance_id: IID, method: 'request', input: {} }, ctx)
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/not found/)
	})

	it('returns error when instance status is not "connected"', async () => {
		const manager = makeManager({
			getInstance: vi.fn(() => makeInstance({ status: 'disconnected' })),
		} as unknown as Partial<ConnectorManager>)
		const tool = createConnectorExecuteTool({ manager })
		const result = await tool.execute({ instance_id: IID, method: 'request', input: {} }, ctx)
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/not connected/)
		expect(result.error).toMatch(/disconnected/)
	})

	it('wraps manager.execute failure; falls back to "Connector execution failed" on undefined error', async () => {
		const manager = makeManager()
		vi.mocked(manager.execute).mockResolvedValueOnce({
			success: false,
			output: undefined,
			durationMs: 1,
		})
		const tool = createConnectorExecuteTool({ manager })
		const result = await tool.execute({ instance_id: IID, method: 'request', input: {} }, ctx)
		expect(result.success).toBe(false)
		expect(result.error).toBe('Connector execution failed')
	})

	it('carries the explicit error message when provided by manager.execute', async () => {
		const manager = makeManager()
		vi.mocked(manager.execute).mockResolvedValueOnce({
			success: false,
			output: undefined,
			durationMs: 1,
			error: 'timeout',
		})
		const tool = createConnectorExecuteTool({ manager })
		const result = await tool.execute({ instance_id: IID, method: 'request', input: {} }, ctx)
		expect(result.error).toBe('timeout')
	})

	it('passes through string outputs as-is', async () => {
		const manager = makeManager()
		vi.mocked(manager.execute).mockResolvedValueOnce({
			success: true,
			output: 'hi there',
			durationMs: 10,
		})
		const tool = createConnectorExecuteTool({ manager })
		const result = await tool.execute({ instance_id: IID, method: 'request', input: {} }, ctx)
		expect(result.success).toBe(true)
		expect(result.output).toBe('hi there')
	})

	it('stringifies non-string outputs + attaches durationMs + metadata to data', async () => {
		const manager = makeManager()
		vi.mocked(manager.execute).mockResolvedValueOnce({
			success: true,
			output: { answer: 42 },
			durationMs: 15,
			metadata: { region: 'us-east-1' },
		})
		const tool = createConnectorExecuteTool({ manager })
		const result = await tool.execute({ instance_id: IID, method: 'request', input: {} }, ctx)
		expect(result.output).toBe(JSON.stringify({ answer: 42 }, null, 2))
		expect(result.data).toEqual({ durationMs: 15, metadata: { region: 'us-east-1' } })
	})
})

describe('createConnectorListTool', () => {
	it('is named connector_list + read-only', () => {
		const tool = createConnectorListTool({ manager: makeManager() })
		expect(tool.name).toBe('connector_list')
		expect(tool.isReadOnly?.({})).toBe(true)
	})

	it('emits "No connector instances configured." when none', async () => {
		const manager = makeManager({
			listInstances: vi.fn(() => []),
		} as unknown as Partial<ConnectorManager>)
		const tool = createConnectorListTool({ manager })
		const result = await tool.execute({}, ctx)
		expect(result.success).toBe(true)
		expect(result.output).toBe('No connector instances configured.')
	})

	it('lists every instance with id / connectorId / name / status', async () => {
		const manager = makeManager({
			listInstances: vi.fn(() => [
				makeInstance({ id: IID }),
				makeInstance({
					id: 'ci_def' as ConnectorInstanceId,
					status: 'disconnected',
				}),
			]),
		} as unknown as Partial<ConnectorManager>)
		const tool = createConnectorListTool({ manager })
		const result = await tool.execute({}, ctx)
		expect(result.success).toBe(true)
		expect(result.output).toContain(`- ${IID} (${CID}): default [connected]`)
		expect(result.output).toContain(`- ci_def (${CID}): default [disconnected]`)
		expect(result.data).toBeDefined()
	})
})

describe('createConnectorTools', () => {
	it('returns both execute + list tools', () => {
		const tools = createConnectorTools({ manager: makeManager() })
		expect(tools.map((t) => t.name)).toEqual(['connector_execute', 'connector_list'])
	})
})
