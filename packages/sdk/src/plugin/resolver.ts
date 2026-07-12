import { PLUGIN_NAMESPACE_SEPARATOR } from '../constants/plugin/index.js'
import type { PluginRegistry } from '../registry/plugin/index.js'
import type { PluginId } from '../types/ids/index.js'
import type { PluginContributionType } from '../types/plugin/index.js'
import type { ToolRegistryContract } from '../types/tool/index.js'
import { composeToolName } from './names.js'

export class PluginResolver {
	private pluginRegistry: PluginRegistry
	private toolRegistry: ToolRegistryContract

	constructor(pluginRegistry: PluginRegistry, toolRegistry: ToolRegistryContract) {
		this.pluginRegistry = pluginRegistry
		this.toolRegistry = toolRegistry
	}

	/**
	 * Parse a composed tool name into the plugin that contributed it and the rest
	 * of the name. Returns null when no installed plugin owns the name.
	 *
	 * The plugin has to be known, not merely syntactically plausible: `__` is legal
	 * inside a tool name no plugin composed — nothing stops a consumer registering
	 * `my__tool` directly — and reporting that tool as belonging to a plugin called
	 * `my` is a lie the callers would act on.
	 */
	resolveToolName(qualifiedName: string): { pluginName: string; toolName: string } | null {
		const parsed = this.split(qualifiedName)
		if (!parsed) return null
		if (!this.pluginRegistry.findByName(parsed.pluginName)) return null

		return {
			pluginName: parsed.pluginName,
			toolName: parsed.components.join(PLUGIN_NAMESPACE_SEPARATOR),
		}
	}

	/**
	 * Lists all tool names contributed by a specific plugin.
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
		const parsed = this.split(qualifiedName)
		if (!parsed) return undefined

		const definition = this.pluginRegistry.findByName(parsed.pluginName)
		if (!definition) return undefined

		// `plugin__server__tool`: the contribution is the MCP SERVER, and the
		// component naming it is the first one after the plugin. Testing the whole
		// `server__tool` tail against the manifest's server names — which is what a
		// single split at the first separator produced — could never match, so every
		// MCP tool came back misclassified as a plain `tool`.
		const [head, ...rest] = parsed.components
		if (head !== undefined && rest.length > 0) {
			if (definition.manifest.mcpServers?.some((s) => s.name === head)) {
				return {
					pluginId: definition.id,
					contributionType: 'mcp_server',
					componentName: head,
				}
			}
		}

		const componentName = parsed.components.join(PLUGIN_NAMESPACE_SEPARATOR)
		const contributionType = this.inferContributionType(definition.id, qualifiedName, componentName)
		if (!contributionType) return undefined

		return {
			pluginId: definition.id,
			contributionType,
			componentName,
		}
	}

	/**
	 * Compose `pluginName__componentName`, validating both parts exactly as the
	 * enable path does.
	 *
	 * This is a public composition entry point, and it used to concatenate the two
	 * strings by hand: a caller could mint `myplugin__read__file`, which is
	 * indistinguishable from the MCP form (plugin `myplugin`, server `read`, tool
	 * `file`) and destroys the injectivity every name-keyed layer — probe vetoes,
	 * plugin hooks, the verification gate — depends on. Names are composed in
	 * exactly one place now.
	 */
	namespaceName(pluginName: string, componentName: string): string {
		return composeToolName(pluginName, [{ role: 'tool', value: componentName }])
	}

	/**
	 * Split a composed name at the FIRST separator. That occurrence is necessarily
	 * the plugin boundary: no component may itself contain `__`, so everything
	 * before the first one is the plugin name and everything after it is the
	 * component list — `[tool]`, or `[server, tool]` for a tool adapted from one of
	 * the plugin's MCP servers.
	 */
	private split(qualifiedName: string): { pluginName: string; components: string[] } | null {
		const parts = qualifiedName.split(PLUGIN_NAMESPACE_SEPARATOR)
		if (parts.length < 2) return null

		const [pluginName, ...components] = parts
		if (!pluginName) return null
		if (components.some((component) => component.length === 0)) return null

		return { pluginName, components }
	}

	private inferContributionType(
		pluginId: PluginId,
		qualifiedName: string,
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

		// Registered at runtime rather than declared in the manifest. The registry is
		// keyed by the composed name, which is the name we were handed — recomposing
		// it here would be a second place where names get built.
		if (this.toolRegistry.has(qualifiedName)) return 'tool'

		return undefined
	}
}
