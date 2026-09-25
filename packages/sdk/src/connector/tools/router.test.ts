/**
 * Connector tool snapshots are derived from connected instances.
 *
 *   - `connectorTools(manager)` defaults strategy to `'per-method'`.
 *   - With strategy `'router'`:
 *     - Returns `[]` when there are no connected instances.
 *     - Returns a single `connector_execute` routing tool otherwise.
 *   - With strategy `'per-method'`:
 *     - Emits one tool per method per connected instance.
 *     - Catches errors per-instance (logs + skips) — a broken instance
 *       does not poison the entire tool list.
 *   - A fresh call reflects the manager's current connected instances.
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { ConnectorManager } from '../../manager/connector/lifecycle.js'
import type { ConnectorRegistry } from '../../registry/connector/definitions.js'
import type { ConnectorDefinition, ConnectorInstance } from '../../types/connector/index.js'
import type { ConnectorId, ConnectorInstanceId } from '../../types/ids/index.js'
import { connectorTools } from './router.js'

const CID = 'dafa33b2-7035-47d2-986c-8a6d2ef338f3' as ConnectorId
const IID1 = 'ef160288-fb1d-4d84-8b1f-a5c5569d10d2' as ConnectorInstanceId
const IID2 = 'dade91b9-7a23-496a-bee5-da4f12dfc86d' as ConnectorInstanceId

function makeDefinition(): ConnectorDefinition {
	return {
		id: CID,
		name: 'HTTP',
		description: 'x',
		connectionType: 'http',
		configSchema: z.object({}),
		methods: [
			{ name: 'request', description: 'd', inputSchema: z.object({}) },
			{ name: 'send', description: 'd', inputSchema: z.object({}) },
		],
	}
}

function makeInstance(id: ConnectorInstanceId): ConnectorInstance {
	return {
		id,
		connectorId: CID,
		config: { connectorId: CID, name: 'x' },
		status: 'connected',
		createdAt: Date.now(),
	}
}

function makeManager(instances: ConnectorInstance[]): ConnectorManager {
	const def = makeDefinition()
	const registry = {
		getOrThrow: vi.fn(() => def),
		get: vi.fn(() => def),
	} as unknown as ConnectorRegistry
	return {
		getInstance: vi.fn((id) => instances.find((i) => i.id === id)),
		getInstanceConnectorId: vi.fn(() => CID),
		getInstanceDefinition: vi.fn(() => def),
		getRegistry: vi.fn(() => registry),
		listConnectedInstances: vi.fn(() => instances),
		listInstances: vi.fn(() => instances),
		execute: vi.fn(),
	} as unknown as ConnectorManager
}

describe('connectorTools', () => {
	it('defaults strategy to per-method', () => {
		const tools = connectorTools(makeManager([makeInstance(IID1)]))
		expect(tools.map((t) => t.name)).toEqual([`${CID}_request`, `${CID}_send`])
	})

	it('router strategy with connected instances emits one connector_execute tool', () => {
		const tools = connectorTools(makeManager([makeInstance(IID1)]), { strategy: 'router' })
		expect(tools).toHaveLength(1)
		expect(tools[0]?.name).toBe('connector_execute')
	})

	it('router strategy with no connected instances returns empty array', () => {
		expect(connectorTools(makeManager([]), { strategy: 'router' })).toEqual([])
	})

	it('per-method strategy with multiple instances emits methods per-instance', () => {
		const tools = connectorTools(makeManager([makeInstance(IID1), makeInstance(IID2)]))
		expect(tools).toHaveLength(4) // 2 methods * 2 instances
	})

	it('per-method strategy skips a broken instance + continues with others', () => {
		const good = makeInstance(IID1)
		const bad = makeInstance(IID2)
		const manager = makeManager([good, bad])
		// make instance IID2 "not found" by overriding getInstance
		vi.mocked(manager.getInstance).mockImplementation((id) => (id === IID1 ? good : undefined))
		const tools = connectorTools(manager)
		// 2 from IID1; IID2 threw + got caught
		expect(tools.map((t) => t.name)).toEqual([`${CID}_request`, `${CID}_send`])
	})
})

describe('connected instance changes', () => {
	it('derives a fresh snapshot after the manager changes', () => {
		const instances = [makeInstance(IID1)]
		const manager = makeManager(instances)
		expect(connectorTools(manager).map((tool) => tool.name)).toEqual([
			`${CID}_request`,
			`${CID}_send`,
		])
		instances.push(makeInstance(IID2))
		expect(connectorTools(manager).map((tool) => tool.name)).toHaveLength(4)
	})
})
