import { join } from 'node:path'
import type { PluginConfig } from '../config/schema.js'
import type { CliPluginInfo } from '../integrations/plugins/runtime.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import type { ChoicePickerOption } from './ChoicePicker.js'
import { choiceDisplayText } from './terminal-choice-text.js'

export function pluginOption(plugin: CliPluginInfo): ChoicePickerOption {
	return {
		label: plugin.name,
		description: pluginSummary(plugin),
		selectedDescription: `${plugin.version} · ${plugin.description}`,
		searchText: `${plugin.name} ${plugin.description} ${plugin.scope}`,
	}
}

export function pluginSummary(plugin: CliPluginInfo): string {
	return `${plugin.status} · ${plugin.scope} · ${plugin.tools.length} tool${plugin.tools.length === 1 ? '' : 's'} · ${plugin.skills.length} skill${plugin.skills.length === 1 ? '' : 's'}`
}

export function pluginDetails(plugin: CliPluginInfo): string {
	const rows = [
		`${plugin.name} · ${plugin.version}`,
		plugin.description,
		`Status: ${plugin.status} · ${plugin.scope}`,
		`After restart or model switch: ${pluginStartupState(plugin)}`,
		...(plugin.startupError ? [plugin.startupError] : []),
		`Directory: ${plugin.rootDir}`,
		`Registered tools: ${plugin.tools.join(', ') || 'none'}`,
		`Registered skills: ${plugin.skills.join(', ') || 'none'}`,
		`Declared hook modules: ${plugin.hookModules.join(', ') || 'none'}`,
		`Declared MCP servers: ${plugin.mcpServers.join(', ') || 'none'}`,
		'Use /plugins to remember the current state for future sessions.',
	]
	return rows.map(choiceDisplayText).join('\n')
}

export function pluginStartupState(plugin: CliPluginInfo): string {
	return plugin.startupEnabled === undefined
		? 'blocked (invalid setting)'
		: plugin.startupEnabled
			? 'enabled'
			: 'disabled'
}

export function emptyPluginReport(config: PluginConfig | undefined, cwd: string): string {
	const home = resolveNamzuHome()
	const scopes = config?.allowedScopes ?? ['project', 'user']
	const reason =
		config?.enabled !== true
			? 'Plugins are off. Set plugins.enabled: true in your Namzu configuration to load trusted plugins at startup.'
			: config.autoDiscovery === false
				? 'Plugin discovery is off (plugins.autoDiscovery: false).'
				: scopes.length === 0
					? 'No plugin scopes are allowed (plugins.allowedScopes: []).'
					: 'No plugins are loaded in this session.'
	return [
		reason,
		`Configuration: ${join(home, 'config.yaml')}`,
		...(scopes.includes('project') ? [`Project plugins: ${join(cwd, '.namzu', 'plugins')}`] : []),
		...(scopes.includes('user') ? [`User plugins: ${join(home, 'plugins')}`] : []),
		'Each plugin directory contains plugin.json. Only Namzu plugin manifests are supported.',
		'Tools, hooks and MCP servers can execute code. Enable only plugins you trust, then restart Namzu.',
	]
		.map(choiceDisplayText)
		.join('\n')
}
