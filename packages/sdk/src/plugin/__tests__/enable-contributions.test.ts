import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginRegistry } from '../../registry/plugin/index.js'
import type { PluginId } from '../../types/ids/index.js'
import type { PluginDefinition } from '../../types/plugin/index.js'
import type { ToolDefinition, ToolRegistryContract } from '../../types/tool/index.js'
import type { Logger } from '../../utils/logger.js'
import { PluginLifecycleManager } from '../lifecycle.js'

const mockConnect = vi.fn(async (): Promise<unknown> => undefined)
const mockDisconnect = vi.fn(async (): Promise<void> => undefined)
const mockListTools = vi.fn(async (): Promise<unknown[]> => [])

vi.mock('../../connector/mcp/client.js', () => ({
	MCPClient: vi.fn().mockImplementation(() => ({
		id: 'mcp-client-mock',
		connect: mockConnect,
		disconnect: mockDisconnect,
		listTools: mockListTools,
	})),
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

function makeLogger(): Logger {
	const s = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...s, child: vi.fn(() => ({ ...s, child: vi.fn() })) } as unknown as Logger
}

function makePluginRegistry(base: Partial<PluginDefinition>): {
	registry: PluginRegistry
	state: { current: PluginDefinition }
} {
	const state = {
		current: {
			id: 'plugin_test' as PluginId,
			manifest: base.manifest ?? {
				name: 'test-plugin',
				version: '0.0.1',
				description: 'test',
			},
			scope: 'project',
			status: 'installed',
			rootDir: '/tmp/plugin',
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
	return { registry, state }
}

function makeToolRegistry(): ToolRegistryContract {
	const names: string[] = []
	return {
		register: vi.fn((tool: ToolDefinition) => {
			names.push(tool.name)
		}),
		unregister: vi.fn((name: string) => {
			const i = names.indexOf(name)
			if (i >= 0) names.splice(i, 1)
		}),
		listNames: vi.fn(() => [...names]),
		has: vi.fn((name: string) => names.includes(name)),
		get: vi.fn(),
		execute: vi.fn(),
		getAvailability: vi.fn(),
	} as unknown as ToolRegistryContract
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
			const { registry } = makePluginRegistry({
				manifest: {
					name: 'p',
					version: '0.0.1',
					description: 't',
					skills: ['./s'],
				},
			})
			const mgr = new PluginLifecycleManager({
				pluginRegistry: registry,
				toolRegistry: makeToolRegistry(),
				log: makeLogger(),
			})
			await expect(mgr.enable(pluginId)).rejects.toThrow(/\[skills\]/)
		})

		it('throws when manifest declares connectors', async () => {
			const { registry } = makePluginRegistry({
				manifest: {
					name: 'p',
					version: '0.0.1',
					description: 't',
					connectors: ['./c'],
				},
			})
			const mgr = new PluginLifecycleManager({
				pluginRegistry: registry,
				toolRegistry: makeToolRegistry(),
				log: makeLogger(),
			})
			await expect(mgr.enable(pluginId)).rejects.toThrow(/\[connectors\]/)
		})

		it('throws when manifest declares personas', async () => {
			const { registry } = makePluginRegistry({
				manifest: {
					name: 'p',
					version: '0.0.1',
					description: 't',
					personas: ['./pp'],
				},
			})
			const mgr = new PluginLifecycleManager({
				pluginRegistry: registry,
				toolRegistry: makeToolRegistry(),
				log: makeLogger(),
			})
			await expect(mgr.enable(pluginId)).rejects.toThrow(/\[personas\]/)
		})

		it('lists all unsupported types together when multiple declared', async () => {
			const { registry } = makePluginRegistry({
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
				toolRegistry: makeToolRegistry(),
				log: makeLogger(),
			})
			await expect(mgr.enable(pluginId)).rejects.toThrow(/skills, connectors, personas/)
		})
	})

	describe('mcpServers wiring', () => {
		it('registers namespaced tools for each MCP server tool', async () => {
			mockConnect.mockResolvedValue(undefined)
			mockListTools.mockResolvedValue([
				{ name: 'read_file', inputSchema: { type: 'object' } },
				{ name: 'write_file', inputSchema: { type: 'object' } },
			])
			const { registry } = makePluginRegistry({
				manifest: {
					name: 'fs-plugin',
					version: '0.0.1',
					description: 't',
					mcpServers: [{ name: 'fs', command: '/bin/true' }],
				},
			})
			const toolRegistry = makeToolRegistry()
			const mgr = new PluginLifecycleManager({
				pluginRegistry: registry,
				toolRegistry,
				log: makeLogger(),
			})

			await mgr.enable(pluginId)

			expect(mockConnect).toHaveBeenCalledOnce()
			expect(mockListTools).toHaveBeenCalledOnce()
			// ses_016: composition is `plugin__server__tool` — the `:` separator and the
			// `mcp__` infix are both gone. `:` is rejected by strict providers, and the
			// infix is no longer needed for injectivity now that no component may
			// contain `__`.
			expect(toolRegistry.listNames()).toEqual([
				'fs-plugin__fs__read_file',
				'fs-plugin__fs__write_file',
			])
		})

		it('disconnects MCP clients and unregisters tools on disable', async () => {
			mockConnect.mockResolvedValue(undefined)
			mockDisconnect.mockResolvedValue(undefined)
			mockListTools.mockResolvedValue([{ name: 'ping', inputSchema: { type: 'object' } }])
			const { registry } = makePluginRegistry({
				manifest: {
					name: 'net',
					version: '0.0.1',
					description: 't',
					mcpServers: [{ name: 'srv', command: '/bin/true' }],
				},
			})
			const toolRegistry = makeToolRegistry()
			const mgr = new PluginLifecycleManager({
				pluginRegistry: registry,
				toolRegistry,
				log: makeLogger(),
			})

			await mgr.enable(pluginId)
			expect(toolRegistry.listNames()).toContain('net__srv__ping')

			await mgr.disable(pluginId)
			expect(mockDisconnect).toHaveBeenCalledOnce()
			expect(toolRegistry.listNames()).toEqual([])
		})

		it('disconnects MCP clients before unregistering tools on disable', async () => {
			mockConnect.mockResolvedValue(undefined)
			mockDisconnect.mockResolvedValue(undefined)
			mockListTools.mockResolvedValue([{ name: 'ping', inputSchema: { type: 'object' } }])
			const { registry } = makePluginRegistry({
				manifest: {
					name: 'net',
					version: '0.0.1',
					description: 't',
					mcpServers: [{ name: 'srv', command: '/bin/true' }],
				},
			})
			const events: string[] = []
			const toolRegistry = {
				register: vi.fn(),
				unregister: vi.fn(() => events.push('unregister')),
				listNames: vi.fn(() => []),
				has: vi.fn(),
				get: vi.fn(),
				execute: vi.fn(),
				getAvailability: vi.fn(),
			} as unknown as ToolRegistryContract
			mockDisconnect.mockImplementation(async () => {
				events.push('disconnect')
			})
			const mgr = new PluginLifecycleManager({
				pluginRegistry: registry,
				toolRegistry,
				log: makeLogger(),
			})

			await mgr.enable(pluginId)
			await mgr.disable(pluginId)

			expect(events).toEqual(['disconnect', 'unregister'])
		})

		it('disconnects a client whose own connect failed, so no subprocess is orphaned', async () => {
			// ses_015 pre-freeze H1. The stdio transport SPAWNS the server process and
			// only then performs the `initialize` handshake, so a handshake failure (wrong
			// protocol version, bad auth) leaves a live child behind. The client was
			// recorded for rollback only after a successful connect, so rollback never saw
			// it and nothing ever sent the SIGTERM — and enable() is retryable from
			// 'error', so each retry orphaned another process.
			mockConnect.mockRejectedValueOnce(new Error('unsupported protocol version'))
			mockDisconnect.mockResolvedValue(undefined)
			const { registry } = makePluginRegistry({
				manifest: {
					name: 'solo',
					version: '0.0.1',
					description: 't',
					mcpServers: [{ name: 'srv', command: '/bin/true' }],
				},
			})
			const mgr = new PluginLifecycleManager({
				pluginRegistry: registry,
				toolRegistry: makeToolRegistry(),
				log: makeLogger(),
			})

			await expect(mgr.enable(pluginId)).rejects.toThrow(/unsupported protocol version/)

			// The only client in this enable is the one that failed to connect.
			expect(mockDisconnect).toHaveBeenCalledOnce()
		})

		it('surfaces the connect failure even when the cleanup disconnect also fails', async () => {
			mockConnect.mockRejectedValueOnce(new Error('unsupported protocol version'))
			mockDisconnect.mockRejectedValue(new Error('transport already dead'))
			const { registry } = makePluginRegistry({
				manifest: {
					name: 'solo',
					version: '0.0.1',
					description: 't',
					mcpServers: [{ name: 'srv', command: '/bin/true' }],
				},
			})
			const mgr = new PluginLifecycleManager({
				pluginRegistry: registry,
				toolRegistry: makeToolRegistry(),
				log: makeLogger(),
			})

			// The teardown must not mask why the enable failed.
			await expect(mgr.enable(pluginId)).rejects.toThrow(/unsupported protocol version/)
		})

		it('rolls back tools and MCP clients when connect fails mid-enable', async () => {
			mockConnect
				.mockResolvedValueOnce(undefined) // first server connects
				.mockRejectedValueOnce(new Error('connect refused')) // second fails
			mockDisconnect.mockResolvedValue(undefined)
			mockListTools.mockResolvedValue([{ name: 't', inputSchema: { type: 'object' } }])
			const { registry } = makePluginRegistry({
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
			const toolRegistry = makeToolRegistry()
			const mgr = new PluginLifecycleManager({
				pluginRegistry: registry,
				toolRegistry,
				log: makeLogger(),
			})

			await expect(mgr.enable(pluginId)).rejects.toThrow(/connect refused/)

			// Rollback: first server's tools unregistered, first client disconnected.
			// Twice, not once: the client that FAILED to connect is torn down at the
			// failure site (it never reaches the rollback record), and the one that had
			// connected is torn down by the rollback (ses_015 pre-freeze H1).
			expect(toolRegistry.listNames()).toEqual([])
			expect(mockDisconnect).toHaveBeenCalledTimes(2)
		})
	})
})
