/**
 * Current-code invariants asserted (2026-07-12, ses_016):
 *
 *   - Composition is `plugin__leaf` / `plugin__server__tool`. The `:` separator
 *     is gone (strict providers reject `:` in a function name) and so is the
 *     `mcp__` infix (it existed to disambiguate, which component validation now
 *     guarantees).
 *   - A component may contain `[a-zA-Z0-9_-]` but never `__`. Single underscores
 *     stay legal, so `read_file` is accepted. Because no component may contain
 *     `__`, every `__` in a composed name is a boundary: `(fs, read_file)` and
 *     `(fs_read, file)` compose to distinct names, and neither `(a, b__c)` nor
 *     `(a__b, c)` is representable at all — both are rejected.
 *   - The composed name is length-checked against the 64-char provider limit at
 *     validation time, BEFORE the enable transaction registers anything. Names
 *     are never truncated: truncation would reintroduce the collisions the
 *     component rule exists to prevent.
 *   - Any enable failure leaves the plugin in `status: 'error'` with the message
 *     attached, and emits `plugin_error`. `error` is retryable — enable() accepts
 *     it as a starting state, since the fix for a bad manifest is to edit it and
 *     enable again, and an MCP server can fail to connect transiently.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { PluginRegistry } from '../../registry/plugin/index.js'
import type { PluginId } from '../../types/ids/index.js'
import type { PluginDefinition, PluginLifecycleEvent } from '../../types/plugin/index.js'
import type { ToolDefinition, ToolRegistryContract } from '../../types/tool/index.js'
import type { Logger } from '../../utils/logger.js'
import { PluginComponentNameError, PluginToolNameTooLongError } from '../errors.js'
import { PluginLifecycleManager } from '../lifecycle.js'
import { assertNameComponent, composeToolName } from '../names.js'

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
		inputSchema: z.object({}),
		async execute() {
			return { success: true, output: 'ok' }
		},
	})),
}))

function makeLogger(): Logger {
	const s = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...s, child: vi.fn(() => ({ ...s, child: vi.fn() })) } as unknown as Logger
}

function makePluginRegistry(manifest: PluginDefinition['manifest']): {
	registry: PluginRegistry
	state: { current: PluginDefinition }
} {
	const state = {
		current: {
			id: 'plugin_test' as PluginId,
			manifest,
			scope: 'project',
			status: 'installed',
			rootDir: '/tmp/plugin',
			installedAt: 0,
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

function makeToolRegistry(): { registry: ToolRegistryContract; registered: string[] } {
	const registered: string[] = []
	const registry = {
		register: vi.fn((tool: ToolDefinition) => {
			registered.push(tool.name)
		}),
		unregister: vi.fn((name: string) => {
			const i = registered.indexOf(name)
			if (i >= 0) registered.splice(i, 1)
		}),
		listNames: vi.fn(() => [...registered]),
		has: vi.fn((name: string) => registered.includes(name)),
		get: vi.fn(),
		execute: vi.fn(),
		getAvailability: vi.fn(),
	} as unknown as ToolRegistryContract
	return { registry, registered }
}

const pluginId = 'plugin_test' as PluginId

describe('component validation (pure)', () => {
	it('accepts snake_case, kebab-case and alphanumerics', () => {
		expect(() => assertNameComponent('p', 'tool', 'read_file')).not.toThrow()
		expect(() => assertNameComponent('p', 'mcp-server', 'fs-server')).not.toThrow()
		expect(() => assertNameComponent('p', 'tool', 'Tool2')).not.toThrow()
	})

	it('rejects a component containing the "__" separator', () => {
		expect(() => assertNameComponent('p', 'tool', 'read__file')).toThrow(PluginComponentNameError)
		expect(() => assertNameComponent('p', 'mcp-server', 'a__b')).toThrow(PluginComponentNameError)
	})

	it('rejects a component with characters a provider would reject', () => {
		expect(() => assertNameComponent('p', 'tool', 'read:file')).toThrow(PluginComponentNameError)
		expect(() => assertNameComponent('p', 'tool', 'read file')).toThrow(PluginComponentNameError)
		expect(() => assertNameComponent('p', 'tool', '')).toThrow(PluginComponentNameError)
	})

	it('composes injectively — (fs, read_file) and (fs_read, file) stay distinct', () => {
		expect(composeToolName('p', [{ role: 'tool', value: 'read_file' }])).toBe('p__read_file')
		expect(
			composeToolName('p', [
				{ role: 'mcp-server', value: 'fs' },
				{ role: 'tool', value: 'read_file' },
			]),
		).toBe('p__fs__read_file')
		expect(
			composeToolName('p', [
				{ role: 'mcp-server', value: 'fs_read' },
				{ role: 'tool', value: 'file' },
			]),
		).toBe('p__fs_read__file')
	})

	it('rejects both halves of the classic collision pair', () => {
		// (a, b__c) and (a__b, c) would collide as `a__b__c` — neither is allowed to
		// be composed in the first place.
		expect(() =>
			composeToolName('p', [
				{ role: 'mcp-server', value: 'a' },
				{ role: 'tool', value: 'b__c' },
			]),
		).toThrow(PluginComponentNameError)
		expect(() =>
			composeToolName('p', [
				{ role: 'mcp-server', value: 'a__b' },
				{ role: 'tool', value: 'c' },
			]),
		).toThrow(PluginComponentNameError)
	})

	it('rejects an over-length composition and names the longest component', () => {
		const longPlugin = 'p'.repeat(40)
		expect(() => composeToolName(longPlugin, [{ role: 'tool', value: 'a'.repeat(30) }])).toThrow(
			PluginToolNameTooLongError,
		)

		try {
			composeToolName(longPlugin, [{ role: 'tool', value: 'a'.repeat(30) }])
		} catch (err) {
			expect((err as Error).message).toContain(longPlugin)
			expect((err as Error).message).toContain('64-character provider limit')
		}
	})
})

describe('enable() name validation', () => {
	beforeEach(() => {
		mockConnect.mockReset()
		mockDisconnect.mockReset()
		mockListTools.mockReset()
	})

	it('rejects an MCP server name containing "__" before it spawns the server', async () => {
		const { registry, state } = makePluginRegistry({
			name: 'p',
			version: '0.0.1',
			description: 't',
			mcpServers: [{ name: 'bad__server', command: '/bin/true' }],
		})
		const { registry: toolRegistry } = makeToolRegistry()
		const mgr = new PluginLifecycleManager({
			pluginRegistry: registry,
			toolRegistry,
			log: makeLogger(),
		})

		await expect(mgr.enable(pluginId)).rejects.toThrow(PluginComponentNameError)
		expect(mockConnect).not.toHaveBeenCalled()
		expect(state.current.status).toBe('error')
	})

	it('rejects an over-length MCP tool name and registers nothing for that server', async () => {
		mockConnect.mockResolvedValue(undefined)
		mockDisconnect.mockResolvedValue(undefined)
		mockListTools.mockResolvedValue([
			{ name: 'short', inputSchema: { type: 'object' } },
			{ name: 'x'.repeat(60), inputSchema: { type: 'object' } },
		])
		const { registry, state } = makePluginRegistry({
			name: 'plugin-with-a-long-name',
			version: '0.0.1',
			description: 't',
			mcpServers: [{ name: 'server', command: '/bin/true' }],
		})
		const { registry: toolRegistry, registered } = makeToolRegistry()
		const mgr = new PluginLifecycleManager({
			pluginRegistry: registry,
			toolRegistry,
			log: makeLogger(),
		})

		await expect(mgr.enable(pluginId)).rejects.toThrow(PluginToolNameTooLongError)

		// The server's tools are validated as a set before any of them is registered,
		// so the legal `short` tool never lands either — no half-registered server.
		expect(registered).toEqual([])
		expect(state.current.status).toBe('error')
		expect(state.current.error).toContain('64-character provider limit')
	})

	it('emits plugin_error and leaves the plugin retryable after a failed enable', async () => {
		const events: PluginLifecycleEvent[] = []
		const { registry, state } = makePluginRegistry({
			name: 'p',
			version: '0.0.1',
			description: 't',
			mcpServers: [{ name: 'bad__server', command: '/bin/true' }],
		})
		const { registry: toolRegistry } = makeToolRegistry()
		const mgr = new PluginLifecycleManager({
			pluginRegistry: registry,
			toolRegistry,
			log: makeLogger(),
		})
		mgr.on((e) => events.push(e))

		await expect(mgr.enable(pluginId)).rejects.toThrow(PluginComponentNameError)

		const errorEvent = events.find((e) => e.type === 'plugin_error')
		expect(errorEvent).toBeDefined()
		expect(state.current.status).toBe('error')

		// From 'error', enable() runs again rather than rejecting on the status guard
		// — it fails on the same bad name, not on "wrong status".
		await expect(mgr.enable(pluginId)).rejects.toThrow(PluginComponentNameError)
	})

	it('composes plugin__server__tool for a well-named MCP server', async () => {
		mockConnect.mockResolvedValue(undefined)
		mockListTools.mockResolvedValue([{ name: 'read_file', inputSchema: { type: 'object' } }])
		const { registry, state } = makePluginRegistry({
			name: 'fs-plugin',
			version: '0.0.1',
			description: 't',
			mcpServers: [{ name: 'fs', command: '/bin/true' }],
		})
		const { registry: toolRegistry, registered } = makeToolRegistry()
		const mgr = new PluginLifecycleManager({
			pluginRegistry: registry,
			toolRegistry,
			log: makeLogger(),
		})

		await mgr.enable(pluginId)

		expect(registered).toEqual(['fs-plugin__fs__read_file'])
		expect(state.current.status).toBe('enabled')
	})

	it('clears the error message when a retried enable succeeds', async () => {
		mockConnect.mockRejectedValueOnce(new Error('connect refused'))
		mockDisconnect.mockResolvedValue(undefined)
		mockListTools.mockResolvedValue([{ name: 'ping', inputSchema: { type: 'object' } }])
		const { registry, state } = makePluginRegistry({
			name: 'net',
			version: '0.0.1',
			description: 't',
			mcpServers: [{ name: 'srv', command: '/bin/true' }],
		})
		const { registry: toolRegistry } = makeToolRegistry()
		const mgr = new PluginLifecycleManager({
			pluginRegistry: registry,
			toolRegistry,
			log: makeLogger(),
		})

		await expect(mgr.enable(pluginId)).rejects.toThrow(/connect refused/)
		expect(state.current.status).toBe('error')
		expect(state.current.error).toContain('connect refused')

		// The server was down, not misconfigured: enabling again succeeds, and the
		// stale message from the failed attempt does not survive.
		mockConnect.mockResolvedValue(undefined)
		await mgr.enable(pluginId)

		expect(state.current.status).toBe('enabled')
		expect(state.current.error).toBeUndefined()
	})
})
