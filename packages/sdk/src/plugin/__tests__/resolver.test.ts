/**
 * Current-code invariants asserted (2026-07-12, ses_016 fix batch):
 *
 *   PluginResolver is a PUBLIC composition path (it is exported from
 *   `public-runtime.ts`), and it was the one the separator change missed: it still
 *   concatenated names by hand and still split at the first separator as if the
 *   separator were `:`.
 *
 *   - `namespaceName` composes through `composeToolName`, so both components are
 *     validated and the composed name is length-checked. Hand concatenation let a
 *     caller mint `myplugin__read__file` — indistinguishable from the MCP form
 *     (plugin `myplugin`, server `read`, tool `file`) — which destroys the
 *     injectivity every name-keyed layer (probe vetoes, plugin hooks, the
 *     verification gate) depends on.
 *   - `resolveComponent` classifies `plugin__server__tool` as the MCP SERVER
 *     contribution. Splitting once at the first `__` yielded the component
 *     `server__tool`, which could never match a declared server name, so every MCP
 *     tool came back misclassified as a plain `tool`.
 *   - A `__` in a name no plugin composed does NOT make it plugin-qualified. With
 *     `:` this could not happen (a plain tool name never contained one); with `__`
 *     a hand-registered `my__tool` false-positives unless the plugin is checked.
 */

import { describe, expect, it, vi } from 'vitest'

import type { PluginRegistry } from '../../registry/plugin/index.js'
import type { PluginId } from '../../types/ids/index.js'
import type { PluginDefinition } from '../../types/plugin/index.js'
import type { ToolRegistryContract } from '../../types/tool/index.js'
import { PluginComponentNameError, PluginToolNameTooLongError } from '../errors.js'
import { PluginResolver } from '../resolver.js'

const pluginId = 'plugin_test' as PluginId

function makeRegistries(
	manifest: PluginDefinition['manifest'],
	registeredTools: string[] = [],
): PluginResolver {
	const definition = {
		id: pluginId,
		manifest,
		scope: 'project',
		status: 'enabled',
		rootDir: '/tmp/plugin',
		installedAt: 0,
	} as PluginDefinition

	const pluginRegistry = {
		getOrThrow: vi.fn(() => definition),
		findByName: vi.fn((name: string) => (name === manifest.name ? definition : undefined)),
	} as unknown as PluginRegistry

	const toolRegistry = {
		listNames: vi.fn(() => registeredTools),
		has: vi.fn((name: string) => registeredTools.includes(name)),
	} as unknown as ToolRegistryContract

	return new PluginResolver(pluginRegistry, toolRegistry)
}

const manifest = {
	name: 'fs-plugin',
	version: '0.0.1',
	description: 't',
	mcpServers: [{ name: 'fs', command: '/bin/true' }],
} as PluginDefinition['manifest']

describe('PluginResolver.namespaceName', () => {
	it('composes through the validated path', () => {
		const resolver = makeRegistries(manifest)
		expect(resolver.namespaceName('fs-plugin', 'read_file')).toBe('fs-plugin__read_file')
	})

	it('rejects a component carrying the separator, instead of minting an ambiguous name', () => {
		const resolver = makeRegistries(manifest)

		// `myplugin__read__file` would be indistinguishable from (myplugin, read, file).
		expect(() => resolver.namespaceName('myplugin', 'read__file')).toThrow(PluginComponentNameError)
	})

	it('rejects a composition that exceeds the provider name limit', () => {
		const resolver = makeRegistries(manifest)
		expect(() => resolver.namespaceName('a'.repeat(40), 'b'.repeat(40))).toThrow(
			PluginToolNameTooLongError,
		)
	})
})

describe('PluginResolver.resolveComponent', () => {
	it('classifies plugin__server__tool as the MCP server contribution', () => {
		const resolver = makeRegistries(manifest, ['fs-plugin__fs__read_file'])

		const resolved = resolver.resolveComponent('fs-plugin__fs__read_file')

		expect(resolved).toEqual({
			pluginId,
			contributionType: 'mcp_server',
			componentName: 'fs',
		})
	})

	it('classifies a plugin leaf tool registered at runtime as a tool', () => {
		const resolver = makeRegistries(manifest, ['fs-plugin__local_tool'])

		expect(resolver.resolveComponent('fs-plugin__local_tool')).toEqual({
			pluginId,
			contributionType: 'tool',
			componentName: 'local_tool',
		})
	})

	it('returns undefined for a name no installed plugin owns', () => {
		const resolver = makeRegistries(manifest, ['my__tool'])
		expect(resolver.resolveComponent('my__tool')).toBeUndefined()
	})
})

describe('PluginResolver.resolveToolName', () => {
	it('splits at the first separator — components cannot contain one', () => {
		const resolver = makeRegistries(manifest)

		expect(resolver.resolveToolName('fs-plugin__fs__read_file')).toEqual({
			pluginName: 'fs-plugin',
			toolName: 'fs__read_file',
		})
	})

	it('returns null for an unqualified name', () => {
		const resolver = makeRegistries(manifest)
		expect(resolver.resolveToolName('read_file')).toBeNull()
	})

	it('does not claim a "__" name that no plugin composed', () => {
		const resolver = makeRegistries(manifest)

		// A consumer may register `my__tool` directly. Reporting it as belonging to a
		// plugin called `my` is a lie the callers would act on.
		expect(resolver.resolveToolName('my__tool')).toBeNull()
	})
})

describe('PluginResolver.getPluginTools', () => {
	it('lists tools by the composed prefix', () => {
		const resolver = makeRegistries(manifest, [
			'fs-plugin__fs__read_file',
			'fs-plugin__local',
			'other__tool',
			'read_file',
		])

		expect(resolver.getPluginTools(pluginId)).toEqual([
			'fs-plugin__fs__read_file',
			'fs-plugin__local',
		])
	})
})
