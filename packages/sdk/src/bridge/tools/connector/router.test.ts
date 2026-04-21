/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 2):
 *
 *   - `new ConnectorToolRouter({ manager })` defaults strategy to
 *     `'per-method'`.
 *   - `getTools()` with strategy `'router'`:
 *     - Returns `[]` when there are no connected instances.
 *     - Returns a single `connector_execute` routing tool otherwise.
 *   - `getTools()` with strategy `'per-method'`:
 *     - Emits one tool per method per connected instance.
 *     - Catches errors per-instance (logs + skips) — a broken instance
 *       does not poison the entire tool list.
 *   - `registerTools(registry)` delegates to `registry.register` for
 *     every tool and returns the list of names.
 *   - `unregisterTools(registry, names)` calls `registry.unregister`
 *     for each name.
 *   - `refreshTools(registry, previous)` is unregister-then-register in
 *     one call; returns the new names list.
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { ConnectorManager } from '../../../manager/connector/lifecycle.js'
import type { ConnectorRegistry } from '../../../registry/connector/definitions.js'
import type { ConnectorDefinition, ConnectorInstance } from '../../../types/connector/index.js'
import type { ConnectorId, ConnectorInstanceId } from '../../../types/ids/index.js'
import type { ToolRegistryContract } from '../../../types/tool/index.js'

import { ConnectorToolRouter } from './router.js'

const CID = 'conn_http' as ConnectorId
const IID1 = 'ci_a' as ConnectorInstanceId
const IID2 = 'ci_b' as ConnectorInstanceId

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
		getRegistry: vi.fn(() => registry),
		listConnectedInstances: vi.fn(() => instances),
		listInstances: vi.fn(() => instances),
		execute: vi.fn(),
	} as unknown as ConnectorManager
}

function makeToolRegistry(): ToolRegistryContract {
	return {
		register: vi.fn(),
		unregister: vi.fn(() => true),
		clear: vi.fn(),
	} as unknown as ToolRegistryContract
}

describe('ConnectorToolRouter', () => {
	it('defaults strategy to per-method', () => {
		const router = new ConnectorToolRouter({ manager: makeManager([makeInstance(IID1)]) })
		const tools = router.getTools()
		expect(tools.map((t) => t.name)).toEqual([`${CID}_request`, `${CID}_send`])
	})

	it('router strategy with connected instances emits one connector_execute tool', () => {
		const router = new ConnectorToolRouter({
			manager: makeManager([makeInstance(IID1)]),
			strategy: 'router',
		})
		const tools = router.getTools()
		expect(tools).toHaveLength(1)
		expect(tools[0]?.name).toBe('connector_execute')
	})

	it('router strategy with no connected instances returns empty array', () => {
		const router = new ConnectorToolRouter({
			manager: makeManager([]),
			strategy: 'router',
		})
		expect(router.getTools()).toEqual([])
	})

	it('per-method strategy with multiple instances emits methods per-instance', () => {
		const router = new ConnectorToolRouter({
			manager: makeManager([makeInstance(IID1), makeInstance(IID2)]),
		})
		const tools = router.getTools()
		expect(tools).toHaveLength(4) // 2 methods * 2 instances
	})

	it('per-method strategy skips a broken instance + continues with others', () => {
		const good = makeInstance(IID1)
		const bad = makeInstance(IID2)
		const manager = makeManager([good, bad])
		// make instance IID2 "not found" by overriding getInstance
		vi.mocked(manager.getInstance).mockImplementation((id) => (id === IID1 ? good : undefined))
		const router = new ConnectorToolRouter({ manager })
		const tools = router.getTools()
		// 2 from IID1; IID2 threw + got caught
		expect(tools.map((t) => t.name)).toEqual([`${CID}_request`, `${CID}_send`])
	})
})

describe('ConnectorToolRouter.registerTools', () => {
	it('registers every tool and returns the names', () => {
		const router = new ConnectorToolRouter({ manager: makeManager([makeInstance(IID1)]) })
		const reg = makeToolRegistry()
		const names = router.registerTools(reg)
		expect(names).toEqual([`${CID}_request`, `${CID}_send`])
		expect(reg.register).toHaveBeenCalledTimes(2)
	})
})

describe('ConnectorToolRouter.unregisterTools', () => {
	it('unregisters each named tool', () => {
		const router = new ConnectorToolRouter({ manager: makeManager([]) })
		const reg = makeToolRegistry()
		router.unregisterTools(reg, ['a', 'b'])
		expect(reg.unregister).toHaveBeenCalledWith('a')
		expect(reg.unregister).toHaveBeenCalledWith('b')
		expect(reg.unregister).toHaveBeenCalledTimes(2)
	})
})

describe('ConnectorToolRouter.refreshTools', () => {
	it('unregisters previous names then registers new ones', () => {
		const router = new ConnectorToolRouter({ manager: makeManager([makeInstance(IID1)]) })
		const reg = makeToolRegistry()
		const newNames = router.refreshTools(reg, [`${CID}_old_method`])
		expect(reg.unregister).toHaveBeenCalledWith(`${CID}_old_method`)
		expect(newNames).toEqual([`${CID}_request`, `${CID}_send`])
		expect(reg.register).toHaveBeenCalledTimes(2)
	})
})
