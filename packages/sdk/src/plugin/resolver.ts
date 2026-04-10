import { PLUGIN_NAMESPACE_SEPARATOR } from '../constants/plugin/index.js'
import type { PluginRegistry } from '../registry/plugin/index.js'
import type { ToolRegistry } from '../registry/tool/execute.js'
import type { PluginId } from '../types/ids/index.js'
import type { PluginContributionType } from '../types/plugin/index.js'

export class PluginResolver {
	private pluginRegistry: PluginRegistry
	private toolRegistry: ToolRegistry

	constructor(pluginRegistry: PluginRegistry, toolRegistry: ToolRegistry) {
		this.pluginRegistry = pluginRegistry
		this.toolRegistry = toolRegistry
	}

	/**
	 * Parses a qualified tool name in `pluginName:toolName` format.
	 * Returns null if the name is not namespaced.
	 */
	resolveToolName(qualifiedName: string): { pluginName: string; toolName: string } | null {
		const sepIndex = qualifiedName.indexOf(PLUGIN_NAMESPACE_SEPARATOR)
		if (sepIndex === -1) return null

		return {
			pluginName: qualifiedName.slice(0, sepIndex),
			toolName: qualifiedName.slice(sepIndex + PLUGIN_NAMESPACE_SEPARATOR.length),
		}
	}

	/**
	 * Lists all tool names contributed by a specific plugin.
	 * Matches tools whose name starts with `manifest.name:`.
	 */
	getPluginTools(pluginId: PluginId): string[] {
		const definition = this.pluginRegistry.getOrThrow(pluginId)
		const prefix = definition.manifest.name + PLUGIN_NAMESPACE_SEPARATOR
		return this.toolRegistry.listNames().filter((name) => name.startsWith(prefix))
	}

	/**
	 * Resolves a fully qualified component name to its plugin, contribution type, and local name.
	 */
	resolveComponent(
		qualifiedName: string,
	):
		| { pluginId: PluginId; contributionType: PluginContributionType; componentName: string }
		| undefined {
		const sepIndex = qualifiedName.indexOf(PLUGIN_NAMESPACE_SEPARATOR)
		if (sepIndex === -1) return undefined

		const pluginName = qualifiedName.slice(0, sepIndex)
		const componentName = qualifiedName.slice(sepIndex + PLUGIN_NAMESPACE_SEPARATOR.length)

		const definition = this.pluginRegistry.findByName(pluginName)
		if (!definition) return undefined

		const contributionType = this.inferContributionType(definition.id, pluginName, componentName)
		if (!contributionType) return undefined

		return {
			pluginId: definition.id,
			contributionType,
			componentName,
		}
	}

	/**
	 * Returns a namespaced name in `pluginName:componentName` format.
	 */
	namespaceName(pluginName: string, componentName: string): string {
		return pluginName + PLUGIN_NAMESPACE_SEPARATOR + componentName
	}

	private inferContributionType(
		pluginId: PluginId,
		pluginName: string,
		componentName: string,
	): PluginContributionType | undefined {
		const definition = this.pluginRegistry.getOrThrow(pluginId)
		const manifest = definition.manifest

		if (manifest.tools?.includes(componentName)) return 'tool'
		if (manifest.skills?.includes(componentName)) return 'skill'
		if (manifest.hooks?.includes(componentName)) return 'hook'
		if (manifest.connectors?.includes(componentName)) return 'connector'
		if (manifest.personas?.includes(componentName)) return 'persona'
		if (manifest.mcpServers?.some((s) => s.name === componentName)) return 'mcp_server'

		// Check if it exists as a registered tool (runtime registration)
		const namespacedToolName = pluginName + PLUGIN_NAMESPACE_SEPARATOR + componentName
		if (this.toolRegistry.has(namespacedToolName)) return 'tool'

		return undefined
	}
}
