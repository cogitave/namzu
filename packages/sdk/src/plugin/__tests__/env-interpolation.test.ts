/**
 * Current-code invariants asserted (2026-07-12, ses_016):
 *
 *   - `interpolateEnvVars` expands `${VAR}` and `${env:VAR}` from the supplied
 *     environment; `$${VAR}` is an escape that yields the literal text `${VAR}`.
 *   - A reference to an unset variable THROWS (`EnvVarNotFoundError`) rather
 *     than expanding to an empty string, so a mis-provisioned deployment fails
 *     at enable() instead of handing the MCP server a blank credential.
 *   - Interpolation is applied to MCP `env` VALUES only. `command` and `args`
 *     are passed through literally: the stdio transport logs both verbatim at
 *     connect, so an interpolated secret there would be written to the logs.
 *   - An interpolation failure is an enable failure — the plugin lands in
 *     `error` and no MCP server is spawned.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { PluginRegistry } from '../../registry/plugin/index.js'
import type { PluginId } from '../../types/ids/index.js'
import type { PluginDefinition } from '../../types/plugin/index.js'
import type { ToolRegistryContract } from '../../types/tool/index.js'
import type { Logger } from '../../utils/logger.js'
import { interpolateEnvVars } from '../env.js'
import { EnvInterpolationError, EnvVarNotFoundError } from '../errors.js'
import { PluginLifecycleManager } from '../lifecycle.js'

const mockConnect = vi.fn(async (): Promise<unknown> => undefined)
const mockDisconnect = vi.fn(async (): Promise<void> => undefined)
const mockListTools = vi.fn(async (): Promise<unknown[]> => [])
const mockClientCtor = vi.fn()

vi.mock('../../connector/mcp/client.js', () => ({
	MCPClient: vi.fn().mockImplementation((config: unknown) => {
		mockClientCtor(config)
		return {
			id: 'mcp-client-mock',
			connect: mockConnect,
			disconnect: mockDisconnect,
			listTools: mockListTools,
		}
	}),
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

function makeManager(mcpServer: Record<string, unknown>): {
	mgr: PluginLifecycleManager
	state: { current: PluginDefinition }
} {
	const state = {
		current: {
			id: 'plugin_test' as PluginId,
			manifest: {
				name: 'p',
				version: '0.0.1',
				description: 't',
				mcpServers: [mcpServer],
			},
			scope: 'project',
			status: 'installed',
			rootDir: '/tmp/plugin',
			installedAt: 0,
		} as unknown as PluginDefinition,
	}
	const pluginRegistry = {
		register: vi.fn((def: PluginDefinition) => {
			state.current = def
		}),
		unregister: vi.fn(),
		getOrThrow: vi.fn(() => state.current),
		findByName: vi.fn(),
	} as unknown as PluginRegistry
	const toolRegistry = {
		register: vi.fn(),
		unregister: vi.fn(),
		listNames: vi.fn(() => []),
		has: vi.fn(),
		get: vi.fn(),
		execute: vi.fn(),
		getAvailability: vi.fn(),
	} as unknown as ToolRegistryContract

	return {
		mgr: new PluginLifecycleManager({ pluginRegistry, toolRegistry, log: makeLogger() }),
		state,
	}
}

const pluginId = 'plugin_test' as PluginId

describe('interpolateEnvVars (pure)', () => {
	const env = { API_KEY: 'sk-123', HOME: '/home/dev', EMPTY: '' }

	it('expands ${VAR}', () => {
		expect(interpolateEnvVars('${API_KEY}', env)).toBe('sk-123')
		expect(interpolateEnvVars('Bearer ${API_KEY}!', env)).toBe('Bearer sk-123!')
	})

	it('expands ${env:VAR}', () => {
		expect(interpolateEnvVars('${env:API_KEY}', env)).toBe('sk-123')
	})

	it('expands several references in one value', () => {
		expect(interpolateEnvVars('${HOME}/.config/${env:API_KEY}', env)).toBe(
			'/home/dev/.config/sk-123',
		)
	})

	it('treats $${VAR} as an escape yielding the literal ${VAR}', () => {
		expect(interpolateEnvVars('$${API_KEY}', env)).toBe('${API_KEY}')
		expect(interpolateEnvVars('literal $${NOT_SET} stays', env)).toBe('literal ${NOT_SET} stays')
	})

	it('expands an empty-but-set variable', () => {
		expect(interpolateEnvVars('[${EMPTY}]', env)).toBe('[]')
	})

	it('throws on a missing variable rather than expanding to empty', () => {
		expect(() => interpolateEnvVars('${MISSING}', env)).toThrow(EnvVarNotFoundError)
		expect(() => interpolateEnvVars('${env:MISSING}', env)).toThrow(EnvVarNotFoundError)
	})

	it('throws on an empty reference', () => {
		expect(() => interpolateEnvVars('${}', env)).toThrow(EnvInterpolationError)
	})

	it('leaves a value with no references untouched', () => {
		expect(interpolateEnvVars('plain', env)).toBe('plain')
		expect(interpolateEnvVars('$NOT_BRACED', env)).toBe('$NOT_BRACED')
	})
})

describe('attachMCPServer env interpolation', () => {
	beforeEach(() => {
		mockConnect.mockReset()
		mockDisconnect.mockReset()
		mockListTools.mockReset()
		mockClientCtor.mockReset()
		mockConnect.mockResolvedValue(undefined)
		mockListTools.mockResolvedValue([])
		process.env.SES016_TEST_KEY = 'secret-value'
	})

	it('interpolates env values, and leaves command and args literal', async () => {
		const { mgr } = makeManager({
			name: 'srv',
			command: '/bin/server',
			// If args were interpolated, the secret would be written to the connect log.
			args: ['--key=${SES016_TEST_KEY}'],
			env: { API_KEY: '${SES016_TEST_KEY}', MODE: 'prod' },
		})

		await mgr.enable(pluginId)

		const config = mockClientCtor.mock.calls[0]?.[0] as {
			transport: { command: string; args?: string[]; env?: Record<string, string> }
		}
		expect(config.transport.env).toEqual({ API_KEY: 'secret-value', MODE: 'prod' })
		expect(config.transport.command).toBe('/bin/server')
		expect(config.transport.args).toEqual(['--key=${SES016_TEST_KEY}'])
	})

	it('fails enable() loudly when an env value references a missing variable', async () => {
		const { mgr, state } = makeManager({
			name: 'srv',
			command: '/bin/server',
			env: { API_KEY: '${SES016_DEFINITELY_NOT_SET}' },
		})

		await expect(mgr.enable(pluginId)).rejects.toThrow(EnvVarNotFoundError)

		// Interpolation happens before connect, so nothing was spawned.
		expect(mockConnect).not.toHaveBeenCalled()
		expect(state.current.status).toBe('error')
	})
})
