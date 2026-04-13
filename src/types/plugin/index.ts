import { z } from 'zod'
import {
	MAX_CONNECTORS_PER_PLUGIN,
	MAX_HOOKS_PER_PLUGIN,
	MAX_MCP_SERVERS_PER_PLUGIN,
	MAX_PERSONAS_PER_PLUGIN,
	MAX_SKILLS_PER_PLUGIN,
	MAX_TOOLS_PER_PLUGIN,
	PLUGIN_NAME_MAX_LENGTH,
} from '../../constants/plugin/index.js'
import type { PluginId, RunId } from '../ids/index.js'
import type { ToolResult } from '../tool/index.js'

// ---------------------------------------------------------------------------
// Plugin scope — where the plugin is installed
// ---------------------------------------------------------------------------

export type PluginScope = 'project' | 'user'

export function assertPluginScope(scope: PluginScope): void {
	switch (scope) {
		case 'project':
		case 'user':
			return
		default: {
			const _exhaustive: never = scope
			throw new Error(`Unknown PluginScope: ${_exhaustive}`)
		}
	}
}

// ---------------------------------------------------------------------------
// Plugin status — lifecycle state machine
// ---------------------------------------------------------------------------

export type PluginStatus = 'installed' | 'enabled' | 'disabled' | 'error'

export function assertPluginStatus(status: PluginStatus): void {
	switch (status) {
		case 'installed':
		case 'enabled':
		case 'disabled':
		case 'error':
			return
		default: {
			const _exhaustive: never = status
			throw new Error(`Unknown PluginStatus: ${_exhaustive}`)
		}
	}
}

// ---------------------------------------------------------------------------
// Plugin contribution types
// ---------------------------------------------------------------------------

export type PluginContributionType =
	| 'tool'
	| 'skill'
	| 'hook'
	| 'mcp_server'
	| 'connector'
	| 'persona'

export function assertPluginContributionType(type: PluginContributionType): void {
	switch (type) {
		case 'tool':
		case 'skill':
		case 'hook':
		case 'mcp_server':
		case 'connector':
		case 'persona':
			return
		default: {
			const _exhaustive: never = type
			throw new Error(`Unknown PluginContributionType: ${_exhaustive}`)
		}
	}
}

// ---------------------------------------------------------------------------
// Hook system
// ---------------------------------------------------------------------------

export type PluginHookEvent =
	| 'run_start'
	| 'run_end'
	| 'pre_tool_use'
	| 'post_tool_use'
	| 'pre_llm_call'
	| 'post_llm_call'
	| 'iteration_start'
	| 'iteration_end'

export function assertPluginHookEvent(event: PluginHookEvent): void {
	switch (event) {
		case 'run_start':
		case 'run_end':
		case 'pre_tool_use':
		case 'post_tool_use':
		case 'pre_llm_call':
		case 'post_llm_call':
		case 'iteration_start':
		case 'iteration_end':
			return
		default: {
			const _exhaustive: never = event
			throw new Error(`Unknown PluginHookEvent: ${_exhaustive}`)
		}
	}
}

export interface PluginHookContext {
	readonly runId: RunId
	readonly pluginId: PluginId
	readonly event: PluginHookEvent
	readonly toolName?: string
	readonly toolInput?: unknown
	readonly toolResult?: ToolResult
	readonly iteration?: number
}

export type PluginHookResult =
	| { action: 'continue' }
	| { action: 'skip'; reason: string }
	| { action: 'modify'; input: unknown }
	| { action: 'error'; message: string }
	| { action: 'resume'; input: string }
	| { action: 'retry' }

export function assertPluginHookResult(result: PluginHookResult): asserts result {
	const action = result.action
	switch (action) {
		case 'continue':
		case 'skip':
		case 'modify':
		case 'error':
		case 'resume':
		case 'retry':
			break
		default: {
			const _exhaustive: never = action
			throw new Error(`Unknown PluginHookResult action: ${_exhaustive}`)
		}
	}
}

export interface PluginHookDefinition {
	readonly event: PluginHookEvent
	readonly handler: (context: PluginHookContext) => Promise<PluginHookResult>
}

// ---------------------------------------------------------------------------
// Plugin MCP server config
// ---------------------------------------------------------------------------

export interface PluginMCPServerConfig {
	readonly name: string
	readonly command: string
	readonly args?: readonly string[]
	readonly env?: Readonly<Record<string, string>>
}

// ---------------------------------------------------------------------------
// Plugin manifest — validated at load time
// ---------------------------------------------------------------------------

export interface PluginManifest {
	readonly name: string
	readonly version: string
	readonly description: string
	readonly author?: string
	readonly tools?: readonly string[]
	readonly skills?: readonly string[]
	readonly hooks?: readonly string[]
	readonly mcpServers?: readonly PluginMCPServerConfig[]
	readonly connectors?: readonly string[]
	readonly personas?: readonly string[]
}

export const PluginMCPServerConfigSchema = z.object({
	name: z.string().min(1),
	command: z.string().min(1),
	args: z.array(z.string()).optional(),
	env: z.record(z.string()).optional(),
})

export const PluginManifestSchema = z.object({
	name: z
		.string()
		.min(1)
		.max(PLUGIN_NAME_MAX_LENGTH)
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Plugin name must be lowercase kebab-case'),
	version: z.string().min(1),
	description: z.string().min(1),
	author: z.string().optional(),
	tools: z.array(z.string()).max(MAX_TOOLS_PER_PLUGIN).optional(),
	skills: z.array(z.string()).max(MAX_SKILLS_PER_PLUGIN).optional(),
	hooks: z.array(z.string()).max(MAX_HOOKS_PER_PLUGIN).optional(),
	mcpServers: z.array(PluginMCPServerConfigSchema).max(MAX_MCP_SERVERS_PER_PLUGIN).optional(),
	connectors: z.array(z.string()).max(MAX_CONNECTORS_PER_PLUGIN).optional(),
	personas: z.array(z.string()).max(MAX_PERSONAS_PER_PLUGIN).optional(),
})

// ---------------------------------------------------------------------------
// Plugin definition — stored in registry
// ---------------------------------------------------------------------------

export interface PluginDefinition {
	readonly id: PluginId
	readonly manifest: PluginManifest
	readonly scope: PluginScope
	readonly status: PluginStatus
	readonly rootDir: string
	readonly installedAt: number
	readonly enabledAt?: number
	readonly error?: string
}

// ---------------------------------------------------------------------------
// Plugin lifecycle events (discriminated union)
// ---------------------------------------------------------------------------

export type PluginLifecycleEvent =
	| { type: 'plugin_installed'; pluginId: PluginId; name: string; scope: PluginScope }
	| { type: 'plugin_enabled'; pluginId: PluginId; name: string }
	| { type: 'plugin_disabled'; pluginId: PluginId; name: string }
	| { type: 'plugin_uninstalled'; pluginId: PluginId; name: string }
	| { type: 'plugin_error'; pluginId: PluginId; name: string; error: string }
	| {
			type: 'plugin_hook_executed'
			pluginId: PluginId
			hookEvent: PluginHookEvent
			durationMs: number
	  }

export type PluginEventListener = (event: PluginLifecycleEvent) => void
