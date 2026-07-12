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
 *
 * ses_016 fix batch — strictness applies only to names the MANIFEST AUTHOR owns:
 *
 *   - The plugin name and its MCP server aliases stay strictly validated: their
 *     author can rename them, so a bad one is a loud error.
 *   - A tool name supplied by the MCP SERVER is canonicalized, never fatal.
 *     Nobody on this side can rename a tool inside someone else's server, so
 *     `notion.search` and `db:query` are repaired rather than rejected — one
 *     nonconforming remote name used to abort the entire plugin enable with a
 *     remediation ("rename the tool") the operator could not perform.
 *   - The two failures canonicalization cannot repair — an over-long composition
 *     and a canonical name that collides — skip THAT ONE TOOL with a
 *     `plugin_tool_skipped` event. Never a rollback.
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

	it('skips an over-length MCP tool name and still enables the plugin', async () => {
		mockConnect.mockResolvedValue(undefined)
		mockDisconnect.mockResolvedValue(undefined)
		mockListTools.mockResolvedValue([
			{ name: 'short', inputSchema: { type: 'object' } },
			{ name: 'x'.repeat(60), inputSchema: { type: 'object' } },
		])
		const events: PluginLifecycleEvent[] = []
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
		mgr.on((e) => events.push(e))

		await mgr.enable(pluginId)

		// The over-long name is the ONE failure canonicalization cannot repair, and
		// the operator cannot rename a tool inside someone else's MCP server. So that
		// one tool is dropped and the plugin still enables — failing the whole enable
		// left them with a permanently un-enableable plugin and no remediation.
		expect(registered).toEqual(['plugin-with-a-long-name__server__short'])
		expect(state.current.status).toBe('enabled')

		const skipped = events.find((e) => e.type === 'plugin_tool_skipped')
		expect(skipped).toMatchObject({
			serverName: 'server',
			toolName: 'x'.repeat(60),
		})
		expect((skipped as { reason: string }).reason).toContain('64-character provider limit')
	})

	it('canonicalizes a nonconforming remote tool name instead of failing the enable', async () => {
		mockConnect.mockResolvedValue(undefined)
		mockListTools.mockResolvedValue([
			{ name: 'notion.search', inputSchema: { type: 'object' } },
			{ name: 'db:query', inputSchema: { type: 'object' } },
		])
		const { registry, state } = makePluginRegistry({
			name: 'notion',
			version: '0.0.1',
			description: 't',
			mcpServers: [{ name: 'srv', command: '/bin/true' }],
		})
		const { registry: toolRegistry, registered } = makeToolRegistry()
		const mgr = new PluginLifecycleManager({
			pluginRegistry: registry,
			toolRegistry,
			log: makeLogger(),
		})

		await mgr.enable(pluginId)

		// The MCP spec does not constrain tool names, and `notion.search` / `db:query`
		// are real. Strict validation made one of them fatal to the whole plugin.
		// A repaired leaf carries a hash of the original, so two remote names can
		// never collapse onto one registry key (pre-freeze B3).
		expect(registered).toHaveLength(2)
		expect(registered[0]).toMatch(/^notion__srv__notion_search_[a-z0-9]{7}$/)
		expect(registered[1]).toMatch(/^notion__srv__db_query_[a-z0-9]{7}$/)
		expect(state.current.status).toBe('enabled')
	})

	it('registers BOTH tools whose sanitized names would have collapsed together', async () => {
		// The pre-freeze B3 kill case, at the lifecycle level. `a.b` and `a:b` both
		// sanitize to `a_b`, so the second used to be dropped as a duplicate and the
		// first kept the key. MCP enumeration order is not stable across restarts, so
		// the SAME persisted tool name could come back bound to a DIFFERENT remote
		// tool. Both must register, under distinct keys.
		mockConnect.mockResolvedValue(undefined)
		mockListTools.mockResolvedValue([
			{ name: 'a.b', inputSchema: { type: 'object' } },
			{ name: 'a:b', inputSchema: { type: 'object' } },
		])
		const events: PluginLifecycleEvent[] = []
		const { registry, state } = makePluginRegistry({
			name: 'p',
			version: '0.0.1',
			description: 't',
			mcpServers: [{ name: 'srv', command: '/bin/true' }],
		})
		const { registry: toolRegistry, registered } = makeToolRegistry()
		const mgr = new PluginLifecycleManager({
			pluginRegistry: registry,
			toolRegistry,
			log: makeLogger(),
		})
		mgr.on((e) => events.push(e))

		await mgr.enable(pluginId)

		expect(registered).toHaveLength(2)
		expect(new Set(registered).size).toBe(2)
		expect(state.current.status).toBe('enabled')
		expect(events.find((e) => e.type === 'plugin_tool_skipped')).toBeUndefined()
	})

	it('skips a tool a server advertised twice, without rolling back', async () => {
		// What the skip path is now FOR: a genuinely duplicate raw name is a server
		// error, and nothing on this side can disambiguate the two. It is dropped and
		// reported rather than silently aliased onto the first one's key.
		mockConnect.mockResolvedValue(undefined)
		mockListTools.mockResolvedValue([
			{ name: 'a.b', inputSchema: { type: 'object' } },
			{ name: 'a.b', inputSchema: { type: 'object' } },
		])
		const events: PluginLifecycleEvent[] = []
		const { registry, state } = makePluginRegistry({
			name: 'p',
			version: '0.0.1',
			description: 't',
			mcpServers: [{ name: 'srv', command: '/bin/true' }],
		})
		const { registry: toolRegistry, registered } = makeToolRegistry()
		const mgr = new PluginLifecycleManager({
			pluginRegistry: registry,
			toolRegistry,
			log: makeLogger(),
		})
		mgr.on((e) => events.push(e))

		await mgr.enable(pluginId)

		expect(registered).toHaveLength(1)
		expect(state.current.status).toBe('enabled')
		expect(events.find((e) => e.type === 'plugin_tool_skipped')).toMatchObject({
			toolName: 'a.b',
		})
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
