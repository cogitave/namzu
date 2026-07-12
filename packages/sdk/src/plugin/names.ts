import { PLUGIN_COMPONENT_PATTERN, PLUGIN_NAMESPACE_SEPARATOR } from '../constants/plugin/index.js'
import { TOOL_NAME_MAX_LENGTH } from '../constants/tools/index.js'
import { PluginComponentNameError, PluginToolNameTooLongError } from './errors.js'

export type NameComponentRole = 'plugin' | 'mcp-server' | 'tool'

/**
 * A component may contain `[a-zA-Z0-9_-]` but never `__`. Single underscores stay
 * legal — MCP servers ship tools called `read_file` — while the separator itself
 * is reserved, which is what makes composition injective: `(fs, read_file)` gives
 * `fs__read_file` and `(fs_read, file)` gives `fs_read__file`, and neither can be
 * confused for the other when split back apart.
 */
export function assertNameComponent(
	pluginName: string,
	role: NameComponentRole,
	component: string,
): void {
	if (!PLUGIN_COMPONENT_PATTERN.test(component) || component.includes(PLUGIN_NAMESPACE_SEPARATOR)) {
		throw new PluginComponentNameError(pluginName, role, component)
	}
}

/**
 * Validate every component and compose the model-visible tool name:
 * `plugin__tool` for a plugin's own tool, `plugin__server__tool` for a tool
 * adapted from one of its MCP servers.
 *
 * The composed name is length-checked here rather than at registration, because
 * plugin names alone may be 64 characters: a manifest that is individually valid
 * can still compose past the provider limit, and the failure has to arrive
 * before the enable transaction starts registering things it will have to roll
 * back.
 */
export function composeToolName(
	pluginName: string,
	components: readonly { role: NameComponentRole; value: string }[],
): string {
	assertNameComponent(pluginName, 'plugin', pluginName)
	for (const component of components) {
		assertNameComponent(pluginName, component.role, component.value)
	}

	const all = [pluginName, ...components.map((c) => c.value)]
	const composed = all.join(PLUGIN_NAMESPACE_SEPARATOR)
	if (composed.length > TOOL_NAME_MAX_LENGTH) {
		throw new PluginToolNameTooLongError(pluginName, composed, all)
	}
	return composed
}
