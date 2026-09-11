import { expect, it } from 'vitest'
import { emptyPluginReport, pluginDetails } from './plugin-view.js'

it('projects only declared public metadata and neutralizes terminal controls', () => {
	const text = pluginDetails({
		name: 'ledger',
		version: '1.0.0',
		description: 'test\u001b[2J\nnew row',
		scope: 'user',
		status: 'disabled',
		startupEnabled: false,
		rootDir: '/plugins/ledger',
		tools: [],
		skills: [],
		hookModules: ['hook.mjs'],
		mcpServers: ['ledger-mcp'],
		...{ env: { TOKEN: 'NEVER_DISPLAY_ME' } },
	})
	expect(text).not.toContain('NEVER_DISPLAY_ME')
	expect(text).not.toContain('\u001b')
	expect(text).toContain('test\\u{001b}[2J new row')
	expect(text).toContain('Registered tools: none')
	expect(text).toContain('After restart or model switch: disabled')
	expect(text).toContain('Declared MCP servers: ledger-mcp')
})

it('distinguishes disabled loading, disabled discovery and excluded scopes', () => {
	expect(emptyPluginReport(undefined, '/work')).toContain('Plugins are off')
	expect(emptyPluginReport({ enabled: true, autoDiscovery: false }, '/work')).toContain(
		'discovery is off',
	)
	const empty = emptyPluginReport({ enabled: true, allowedScopes: [] }, '/work')
	expect(empty).toContain('No plugin scopes are allowed')
	expect(empty).not.toContain('Project plugins:')
	expect(empty).not.toContain('User plugins:')
})
