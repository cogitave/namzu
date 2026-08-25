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
import type { Message, ToolResultContent } from '../message/index.js'
import type { CancelCause } from '../run/cancel-cause.js'
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
	| 'run_interrupt'
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
		case 'run_interrupt':
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

/**
 * What an extension is shown about a model call it is about to make.
 *
 * A projection, not the live request object. The wire params carry driver
 * concerns an extension has no business depending on, and handing them
 * over would make every future field of that type part of the plugin
 * contract by accident.
 */
export interface PluginModelRequest {
	readonly model: string
	readonly messages: readonly Message[]
	/** Names only. A hook auditing tool exposure needs the set, not the schemas. */
	readonly toolNames: readonly string[]
	readonly temperature?: number
	readonly maxTokens?: number
}

/** What an extension is shown about the model's reply. */
export interface PluginModelResponse {
	readonly content: string | null
	readonly toolNames: readonly string[]
	readonly finishReason: string
	readonly usage: {
		readonly promptTokens: number
		readonly completionTokens: number
		readonly totalTokens: number
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
	/**
	 * Why the run was stopped, on `run_interrupt`.
	 *
	 * That hook is emitted only for a root run carrying the explicit `user`
	 * cause. Keeping the field typed as the complete cause vocabulary lets a
	 * host narrow normally and leaves room for a future, deliberate expansion
	 * without overloading `event` or an error sentence.
	 */
	readonly cancelCause?: CancelCause

	/**
	 * The request about to be sent, on `pre_llm_call`.
	 *
	 * Both model-call hooks fired directly beside this data and were handed
	 * none of it — only a run id and an iteration number — so an extension
	 * could observe THAT a call was happening and nothing about what it
	 * was. A redaction pass, a prompt audit, a per-tenant token ledger: all
	 * of them needed the one thing the hook did not carry.
	 *
	 * Read-only. Frozen before fan-out for the same reason probe events
	 * are: a hook that mutated the live request would change what every
	 * later hook sees, and the last one registered would silently win.
	 * Shaping the request stays the job of the single-slot host callback
	 * that owns it, where one writer is the contract rather than an
	 * accident of registration order.
	 *
	 * The freeze is one level deep, as elsewhere: each message is a frozen
	 * copy, so writing to one is inert and cannot reach the run's history,
	 * but a nested array inside a message is still the run's own.
	 */
	readonly request?: Readonly<PluginModelRequest>

	/**
	 * What came back, on `post_llm_call`. Read-only, same reasoning.
	 */
	readonly response?: Readonly<PluginModelResponse>
	/**
	 * Aborts when this hook's run is cancelled or its deadline expires.
	 * `run_interrupt` is the exception: the run is already cancelled, so its
	 * handler receives a fresh signal that represents only the bounded cleanup
	 * deadline. The original verdict is available as `cancelCause`.
	 *
	 * The runtime stops waiting on a slow hook either way, but in-process
	 * JavaScript cannot be forcibly stopped. Without a signal the hook itself
	 * never learns it was abandoned: an HTTP request inside it keeps a socket
	 * open and its eventual side effects can happen after the run moved on. A
	 * hook doing I/O must forward this signal and stop publishing when it
	 * aborts.
	 */
	readonly signal?: AbortSignal
}

export type PluginHookResult =
	| { action: 'continue' }
	| { action: 'skip'; reason: string }
	| { action: 'modify'; input: unknown }
	| { action: 'error'; message: string }
	| { action: 'retry' }
	/**
	 * Replace what the model sees, WITHOUT reporting the call as failed.
	 *
	 * The substitution seam already existed and was typed as a failure channel:
	 * the only way a `post_tool_use` hook could change the output was
	 * `action: 'error'`, which prefixes `Error: ` and sets the error flag. So
	 * redacting a credential out of a successful result was delivered to the
	 * model as a tool failure, and the model routed around a call that had
	 * worked — retrying it, or reporting to the user that it had failed.
	 *
	 * That is the difference this variant exists for. `error` says the call went
	 * wrong; this says the call went right and the model may not see all of it.
	 *
	 * `modify` is not this. It carries `input` and belongs to the pre-call
	 * hooks, which is why `post_tool_use` rejects it — a result is not an input,
	 * and reusing the variant would have made one action mean two things
	 * depending on where it was returned.
	 *
	 * Rich content blocks SURVIVE a replace unless `content` is given, because
	 * the common case is redacting text from a result whose image or resource
	 * is unaffected. A hook that needs to drop them passes `content: []`, and a
	 * hook redacting a secret that also appears in an image must — this variant
	 * cannot inspect what it is preserving.
	 */
	| { action: 'replace'; output: string; content?: ToolResultContent }

export function assertPluginHookResult(result: PluginHookResult): asserts result {
	const action = result.action
	switch (action) {
		case 'continue':
		case 'skip':
		case 'modify':
		case 'error':
		case 'retry':
		case 'replace':
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
	/**
	 * Lower runs first. Default 100.
	 *
	 * Order was install order, which is neither declared nor stable — it
	 * depends on when each plugin happened to be installed. That is fine
	 * for hooks that only observe, and wrong for the ones that decide:
	 * `executeHooks` SHORT-CIRCUITS on `skip` and `error`, so a hook that
	 * denies a dangerous command only gets to deny it if it runs before
	 * whatever else stops the chain. A guard that fires depending on
	 * installation history is not a guard.
	 *
	 * Ties keep registration order, so plugins that never set a priority
	 * behave exactly as before. Convention: guards below 100, observers
	 * above.
	 */
	readonly priority?: number
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
