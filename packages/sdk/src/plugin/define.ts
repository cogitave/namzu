import type { PluginHookDefinition, PluginMCPServerConfig } from '../types/plugin/index.js'
import { PluginManifestSchema, assertPluginHookEvent } from '../types/plugin/index.js'
import type { ToolDefinition } from '../types/tool/index.js'

/** A host-authored plugin that needs no manifest file or dynamic import. */
export interface DefinedPlugin {
	readonly name: string
	readonly version: string
	readonly description: string
	readonly tools: readonly ToolDefinition[]
	readonly hooks: readonly PluginHookDefinition[]
	readonly instructions?: string
	readonly mcpServers: readonly PluginMCPServerConfig[]
}

export interface DefinePluginOptions {
	readonly name: string
	readonly version?: string
	readonly description?: string
	readonly tools?: readonly ToolDefinition[]
	readonly hooks?: readonly PluginHookDefinition[]
	readonly instructions?: string
	readonly mcpServers?: readonly PluginMCPServerConfig[]
}

/** Validate and snapshot a plugin supplied directly by the host. */
export function definePlugin(options: DefinePluginOptions): DefinedPlugin {
	const version = options.version ?? '0.0.0'
	const description = options.description ?? `In-code plugin ${options.name}`
	PluginManifestSchema.parse({
		name: options.name,
		version,
		description,
		instructions: options.instructions,
		mcpServers: options.mcpServers,
	})
	for (const hook of options.hooks ?? []) assertPluginHookEvent(hook.event)
	const toolNames = new Set<string>()
	for (const tool of options.tools ?? []) {
		if (toolNames.has(tool.name))
			throw new Error(`Plugin "${options.name}" declares tool "${tool.name}" twice.`)
		toolNames.add(tool.name)
	}
	const serverNames = new Set<string>()
	for (const server of options.mcpServers ?? []) {
		if (serverNames.has(server.name)) {
			throw new Error(`Plugin "${options.name}" declares MCP server "${server.name}" twice.`)
		}
		serverNames.add(server.name)
	}
	return Object.freeze({
		name: options.name,
		version,
		description,
		tools: Object.freeze([...(options.tools ?? [])]),
		hooks: Object.freeze([...(options.hooks ?? [])]),
		...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
		mcpServers: Object.freeze(
			(options.mcpServers ?? []).map((server) =>
				Object.freeze({
					...server,
					...(server.args ? { args: Object.freeze([...server.args]) } : {}),
					...(server.env ? { env: Object.freeze({ ...server.env }) } : {}),
				}),
			),
		),
	})
}
