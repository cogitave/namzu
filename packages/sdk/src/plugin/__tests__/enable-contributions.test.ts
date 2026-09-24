import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginRegistry } from '../../registry/plugin/index.js'
import type { PluginId } from '../../types/ids/index.js'
import type { PluginDefinition } from '../../types/plugin/index.js'
import type { Logger } from '../../utils/logger.js'
import { PluginLifecycleManager } from '../lifecycle.js'

const mockConnect = vi.fn(async (): Promise<unknown> => undefined)
const mockDisconnect = vi.fn(async (): Promise<void> => undefined)
const mockListTools = vi.fn(async (): Promise<unknown[]> => [])

vi.mock('../../connector/mcp/client.js', () => ({
	// `function`, not an arrow, and it has to stay that way: `lifecycle.ts`
	// builds the client with `new MCPClient({…})`. Vitest 3 ran a mock's
	// implementation through `mock.apply` even under `new`, so an arrow
	// returning an object literal worked and this file never had to care.
	// Vitest 4 constructs instead — an arrow has no `[[Construct]]`, so it now
	// throws "(config) => (…) is not a constructor". A `function` is
	// constructible, and because it returns an object that object is what `new`
	// yields, which is the same value the arrow produced. The body is otherwise
	// byte-for-byte the mock that was here.
	//
	// `lint/complexity/useArrowFunction` asks for the arrow back. It cannot have
	// one: the rule is right that this function does not use `this`, and beside
	// the point about `[[Construct]]`, which is the only property that matters
	// here. Suppressed rather than exempted file-wide, so the rule keeps working
	// everywhere else in this file.
	// biome-ignore lint/complexity/useArrowFunction: a constructible mock implementation cannot be an arrow function.
	MCPClient: vi.fn().mockImplementation(function (config: { serverName: string }) {
		return {
			id: 'mcp-client-mock',
			connect: mockConnect,
			disconnect: mockDisconnect,
			listTools: mockListTools,
			// The real client has always had this; the mock did not, which went
			// unnoticed while nothing on this path asked the client which server
			// it was talking to. Admission does — a policy is per server name.
			getState: () => ({
				status: 'connected',
				serverName: config.serverName,
				serverCapabilities: { tools: {} },
			}),
			// Same shape of omission as `getState` above, one layer later: the
			// reconnect supervisor subscribes through this, so a mock without it
			// is a fixture unlike production and the wiring fails only at runtime.
			isConnected: () => true,
			onLifecycle: () => () => {},
			onNotification: () => () => {},
		}
	}),
}))

vi.mock('../../connector/mcp/adapter.js', () => ({
	mcpToolToToolDefinition: vi.fn((mcpTool: { name: string }) => ({
		name: mcpTool.name,
		description: `mcp tool ${mcpTool.name}`,
		inputSchema: { parse: vi.fn() } as any,
		async execute() {
			return { success: true, output: 'ok' }
		},
	})),
}))

/**
 * Recursive, because a real `Logger.child()` returns a `Logger` — which has a
 * `child` of its own, to any depth.
 *
 * This stub used to stop at the grandchild: its `child` was a bare `vi.fn()`
 * returning `undefined`, so the third `.child()` call handed back nothing and
 * the next `.debug()` threw. That was invisible while production bound at most
 * two levels, and became four broken tests the moment it bound three. A
 * fixture unlike production tests a system that does not ship.
 */
function makeLogger(): Logger {
	const s = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...s, child: vi.fn(() => makeLogger()) } as unknown as Logger
}

function makePluginRegistry(base: Partial<PluginDefinition>): {
	registry: PluginRegistry
	state: { current: PluginDefinition }
	scopeRoots: { project: string; user: string }
} {
	const authorityRoot = mkdtempSync(join(tmpdir(), 'namzu-plugin-enable-'))
	tempRoots.push(authorityRoot)
	const rootDir = join(authorityRoot, 'plugin')
	mkdirSync(rootDir, { recursive: true })
	const manifest = base.manifest ?? {
		name: 'test-plugin',
		version: '0.0.1',
		description: 'test',
	}
	writeFileSync(join(rootDir, 'plugin.json'), JSON.stringify(manifest), 'utf8')
	const state = {
		current: {
			id: 'plugin_test' as PluginId,
			manifest,
			scope: 'project',
			status: 'installed',
			rootDir,
			installedAt: 0,
			...base,
		} as PluginDefinition,
	}
	const registry = {
		register: vi.fn((def: PluginDefinition) => {
			state.current = def
		}),
		unregister: vi.fn(),
		getOrThrow: vi.fn(() => state.current),
		findByName: vi.fn(),
		getAll: vi.fn(() => [state.current]),
	} as unknown as PluginRegistry
	return {
		registry,
		state,
		scopeRoots: { project: authorityRoot, user: authorityRoot },
	}
}

const tempRoots: string[] = []

afterEach(() => {
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function toolNames(manager: PluginLifecycleManager): string[] {
	return manager.toolsets.flatMap((entry) => entry.tools().map((tool) => tool.name))
}

describe('PluginLifecycleManager enable() contribution types', () => {
	const pluginId = 'plugin_test' as PluginId

	beforeEach(() => {
		mockConnect.mockReset()
		mockDisconnect.mockReset()
		mockListTools.mockReset()
	})

	describe('unsupported contribution types', () => {
		it('throws when manifest declares skills', async () => {
			const { registry, scopeRoots } = makePluginRegistry({
				manifest: {
					name: 'p',
					version: '0.0.1',
					description: 't',
					skills: ['./s'],
				},
			})
			const mgr = new PluginLifecycleManager({
				pluginRegistry: registry,
				scopeRoots,
				log: makeLogger(),
			})
			await expect(mgr.enable(pluginId)).rejects.toThrow(/\[skills\]/)
		})

		it('throws when manifest declares connectors', async () => {
			const { registry, scopeRoots } = makePluginRegistry({
				manifest: {
					name: 'p',
					version: '0.0.1',
					description: 't',
					connectors: ['./c'],
				},
			})
			const mgr = new PluginLifecycleManager({
				pluginRegistry: registry,
				scopeRoots,
				log: makeLogger(),
			})
			await expect(mgr.enable(pluginId)).rejects.toThrow(/\[connectors\]/)
		})

		it('throws when manifest declares personas', async () => {
			const { registry, scopeRoots } = makePluginRegistry({
				manifest: {
					name: 'p',
					version: '0.0.1',
					description: 't',
					personas: ['./pp'],
				},
			})
			const mgr = new PluginLifecycleManager({
				pluginRegistry: registry,
				scopeRoots,
				log: makeLogger(),
			})
			await expect(mgr.enable(pluginId)).rejects.toThrow(/\[personas\]/)
		})

		it('lists all unsupported types together when multiple declared', async () => {
			const { registry, scopeRoots } = makePluginRegistry({
				manifest: {
					name: 'p',
					version: '0.0.1',
					description: 't',
					skills: ['./s'],
					connectors: ['./c'],
					personas: ['./pp'],
				},
			})
			const mgr = new PluginLifecycleManager({
				pluginRegistry: registry,
				scopeRoots,
				log: makeLogger(),
			})
			await expect(mgr.enable(pluginId)).rejects.toThrow(/skills, connectors, personas/)
		})
	})

	describe('mcpServers wiring', () => {
		it('uninstalls manager-owned contributions after the public registry status is overwritten', async () => {
			mockConnect.mockResolvedValue(undefined)
			mockDisconnect.mockResolvedValue(undefined)
			mockListTools.mockResolvedValue([{ name: 'ping', inputSchema: { type: 'object' } }])
			const authorityRoot = mkdtempSync(join(tmpdir(), 'namzu-plugin-owned-state-'))
			tempRoots.push(authorityRoot)
			const rootDir = join(authorityRoot, 'plugin')
			mkdirSync(rootDir, { recursive: true })
			writeFileSync(
				join(rootDir, 'plugin.json'),
				JSON.stringify({
					name: 'owned-state',
					version: '0.0.1',
					description: 'test',
					mcpServers: [{ name: 'srv', command: '/bin/true' }],
				}),
				'utf8',
			)
			const registry = new PluginRegistry()
			const mgr = new PluginLifecycleManager({
				pluginRegistry: registry,
				scopeRoots: { project: authorityRoot, user: authorityRoot },
				log: makeLogger(),
			})
			const installed = await mgr.install(rootDir, 'project')

			await mgr.enable(installed.id)
			const enabled = registry.getOrThrow(installed.id)
			registry.register({ ...enabled, status: 'disabled', enabledAt: undefined })
			await expect(mgr.enable(installed.id)).rejects.toThrow(/status is "enabled"/)
			expect(mockConnect).toHaveBeenCalledOnce()

			registry.register({ ...enabled, status: 'installed', enabledAt: undefined })
			await mgr.uninstall(installed.id)

			expect(mockDisconnect).toHaveBeenCalledOnce()
			expect(toolNames(mgr)).toEqual([])
			expect(registry.get(installed.id)).toBeUndefined()
		})

		it('registers namespaced tools for each MCP server tool', async () => {
			mockConnect.mockResolvedValue(undefined)
			mockListTools.mockResolvedValue([
				{ name: 'read_file', inputSchema: { type: 'object' } },
				{ name: 'write_file', inputSchema: { type: 'object' } },
			])
			const { registry, scopeRoots } = makePluginRegistry({
				manifest: {
					name: 'fs-plugin',
					version: '0.0.1',
					description: 't',
					mcpServers: [{ name: 'fs', command: '/bin/true' }],
				},
			})
			const mgr = new PluginLifecycleManager({
				pluginRegistry: registry,
				scopeRoots,
				log: makeLogger(),
			})

			await mgr.enable(pluginId)

			expect(mockConnect).toHaveBeenCalledOnce()
			expect(mockListTools).toHaveBeenCalledTimes(2)
			expect(toolNames(mgr)).toEqual([
				'fs-plugin__mcp__fs__read_file',
				'fs-plugin__mcp__fs__write_file',
			])
		})

		it('disconnects MCP clients and unregisters tools on disable', async () => {
			mockConnect.mockResolvedValue(undefined)
			mockDisconnect.mockResolvedValue(undefined)
			mockListTools.mockResolvedValue([{ name: 'ping', inputSchema: { type: 'object' } }])
			const { registry, scopeRoots } = makePluginRegistry({
				manifest: {
					name: 'net',
					version: '0.0.1',
					description: 't',
					mcpServers: [{ name: 'srv', command: '/bin/true' }],
				},
			})
			const mgr = new PluginLifecycleManager({
				pluginRegistry: registry,
				scopeRoots,
				log: makeLogger(),
			})

			await mgr.enable(pluginId)
			expect(toolNames(mgr)).toContain('net__mcp__srv__ping')

			await mgr.disable(pluginId)
			expect(mockDisconnect).toHaveBeenCalledOnce()
			expect(toolNames(mgr)).toEqual([])
		})

		it('disconnects MCP clients before unregistering tools on disable', async () => {
			mockConnect.mockResolvedValue(undefined)
			mockDisconnect.mockResolvedValue(undefined)
			mockListTools.mockResolvedValue([{ name: 'ping', inputSchema: { type: 'object' } }])
			const { registry, scopeRoots } = makePluginRegistry({
				manifest: {
					name: 'net',
					version: '0.0.1',
					description: 't',
					mcpServers: [{ name: 'srv', command: '/bin/true' }],
				},
			})
			const events: string[] = []
			mockDisconnect.mockImplementation(async () => {
				events.push('disconnect')
				expect(toolNames(mgr)).toContain('net__mcp__srv__ping')
			})
			const mgr = new PluginLifecycleManager({
				pluginRegistry: registry,
				scopeRoots,
				log: makeLogger(),
			})

			await mgr.enable(pluginId)
			expect(toolNames(mgr)).toContain('net__mcp__srv__ping')
			await mgr.disable(pluginId)

			expect(events).toEqual(['disconnect'])
			expect(toolNames(mgr)).toEqual([])
		})

		it('rolls back tools and MCP clients when connect fails mid-enable', async () => {
			mockConnect
				.mockResolvedValueOnce(undefined) // first server connects
				.mockRejectedValueOnce(new Error('connect refused')) // second fails
			mockDisconnect.mockResolvedValue(undefined)
			mockListTools.mockResolvedValue([{ name: 't', inputSchema: { type: 'object' } }])
			const { registry, scopeRoots } = makePluginRegistry({
				manifest: {
					name: 'multi',
					version: '0.0.1',
					description: 't',
					mcpServers: [
						{ name: 'a', command: '/bin/true' },
						{ name: 'b', command: '/bin/false' },
					],
				},
			})
			const mgr = new PluginLifecycleManager({
				pluginRegistry: registry,
				scopeRoots,
				log: makeLogger(),
			})

			await expect(mgr.enable(pluginId)).rejects.toThrow(/connect refused/)

			// Rollback: first server's tools unregistered, first client disconnected.
			expect(toolNames(mgr)).toEqual([])
			expect(mockDisconnect).toHaveBeenCalledOnce()
		})
	})
})
