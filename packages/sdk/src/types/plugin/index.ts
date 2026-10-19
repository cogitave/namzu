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
import type {
	RequestContextChange,
	RequestContextSnapshot,
} from '../../runtime/query/request-context.js'
import type { PluginId, SessionId, TurnId } from '../ids/index.js'
import type { Message, ToolResultContent } from '../message/index.js'
import type { CancelCause } from '../session/cancel-cause.js'
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
	/**
	 * The operator's prompt, before the model sees it. Carries `prompt`.
	 * The one event that can BLOCK a turn (`skip`) and the one that can add
	 * to what the model is told (`annotate`).
	 */
	| 'user_prompt_submit'
	/** A host's session opened or closed. Carries `sessionId` and no `turnId`: these hooks run outside any turn. */
	| 'session_start'
	| 'session_end'
	/** A compaction pass is about to run / has run. Carries `compaction`. */
	| 'pre_compact'
	| 'post_compact'
	/** A child session's turn ended. Fired after its own `turn_end`; carries `parentSessionId` and `parentTurnId`. */
	| 'subagent_stop'
	| 'turn_start'
	| 'turn_end'
	| 'turn_interrupt'
	| 'pre_tool_use'
	| 'post_tool_use'
	/**
	 * A tool call ended in failure. Fired after `post_tool_use` for the same
	 * call, only when the result is a failure. Carries `toolName`, `toolInput`
	 * and `toolResult`.
	 */
	| 'post_tool_use_failure'
	/**
	 * A person is about to be asked whether a tool call may run. Carries
	 * `toolName` and `toolInput`. A hook may answer before the question is
	 * shown: `continue` with `permission: { decision: 'allow' }` approves the
	 * call (never one that is always asked about), `skip` refuses it.
	 */
	| 'permission_request'
	/**
	 * The host wants the operator's attention: a review is waiting, or a turn
	 * settled. Carries `notification` (`type` and `message`). Observational.
	 */
	| 'notification'
	| 'pre_llm_call'
	| 'post_llm_call'
	| 'iteration_start'
	| 'iteration_end'

/**
 * Hook event names that were renamed when turns replaced runs. A config that
 * still names one is refused, and the refusal names the replacement.
 */
export const RENAMED_PLUGIN_HOOK_EVENTS: Readonly<Record<string, PluginHookEvent>> = {
	run_start: 'turn_start',
	run_end: 'turn_end',
	run_interrupt: 'turn_interrupt',
}

export function assertPluginHookEvent(event: PluginHookEvent): void {
	const renamed = RENAMED_PLUGIN_HOOK_EVENTS[event as string]
	if (renamed !== undefined) {
		throw new Error(`Hook event '${event as string}' was renamed to '${renamed}'.`)
	}
	switch (event) {
		case 'user_prompt_submit':
		case 'session_start':
		case 'session_end':
		case 'pre_compact':
		case 'post_compact':
		case 'subagent_stop':
		case 'turn_start':
		case 'turn_end':
		case 'turn_interrupt':
		case 'pre_tool_use':
		case 'post_tool_use':
		case 'post_tool_use_failure':
		case 'permission_request':
		case 'notification':
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
	/** SDK provider-input content inventory; excludes adapter/server-private transformations. */
	readonly context?: {
		readonly snapshot: RequestContextSnapshot
		/** Compared with the preceding pre_llm_call in this turn; absent on the first. */
		readonly change?: RequestContextChange
	}
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

/** What a compaction hook is shown about the pass. */
export interface PluginCompactionInfo {
	/** `threshold`: the estimate crossed the line. `overflow`: the provider rejected the prompt. */
	readonly reason: 'threshold' | 'overflow'
	readonly tokensBefore: number
	/** Present on `post_compact`. */
	readonly tokensAfter?: number
	readonly contextWindowTokens: number
}

/** What a `notification` hook is shown. */
export interface PluginNotificationInfo {
	/** `approval_required` (a review is waiting) or `turn_settled` (a turn ended). */
	readonly type: 'approval_required' | 'turn_settled'
	readonly message: string
}

export interface PluginHookContext {
	/** The turn the hook fired in. Absent on `session_start` and `session_end`. */
	readonly turnId?: TurnId
	readonly pluginId: PluginId
	readonly event: PluginHookEvent
	/** The host's session. Always present. */
	readonly sessionId: SessionId
	/** The session that delegated, on `subagent_stop`. */
	readonly parentSessionId?: SessionId
	/** The turn whose tool call spawned the child, on `subagent_stop`. */
	readonly parentTurnId?: TurnId
	/** The operator's prompt, on `user_prompt_submit`. */
	readonly prompt?: string
	/** The pass, on `pre_compact` and `post_compact`. */
	readonly compaction?: PluginCompactionInfo
	readonly toolName?: string
	readonly toolInput?: unknown
	readonly toolResult?: ToolResult
	/** What the host is telling the operator, on `notification`. */
	readonly notification?: PluginNotificationInfo
	/**
	 * On `turn_end` and `subagent_stop` when an earlier answer to the same
	 * event kept the turn going: the hook is being asked again about a turn it
	 * already refused to let end. A hook that always refuses would otherwise
	 * keep the model working until the turn's own limits stop it.
	 */
	readonly stopHookActive?: boolean
	readonly iteration?: number
	/**
	 * Why the turn was stopped, on `turn_interrupt`.
	 *
	 * That hook is emitted only for a root session's turn carrying the explicit `user`
	 * cause. Keeping the field typed as the complete cause vocabulary lets a
	 * host narrow normally and leaves room for a future, deliberate expansion
	 * without overloading `event` or an error sentence.
	 */
	readonly cancelCause?: CancelCause

	/**
	 * The request about to be sent, on `pre_llm_call`.
	 *
	 * Both model-call hooks fired directly beside this data and were handed
	 * none of it — only a turn id and an iteration number — so an extension
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
	 * copy, so writing to one is inert and cannot reach the turn's history,
	 * but a nested array inside a message is still the turn's own.
	 */
	readonly request?: Readonly<PluginModelRequest>

	/**
	 * What came back, on `post_llm_call`. Read-only, same reasoning.
	 */
	readonly response?: Readonly<PluginModelResponse>
	/**
	 * Aborts when this hook's run is cancelled or its deadline expires.
	 * `turn_interrupt` is the exception: the turn is already cancelled, so its
	 * handler receives a fresh signal that represents only the bounded cleanup
	 * deadline. The original verdict is available as `cancelCause`.
	 *
	 * The runtime stops waiting on a slow hook either way, but in-process
	 * JavaScript cannot be forcibly stopped. Without a signal the hook itself
	 * never learns it was abandoned: an HTTP request inside it keeps a socket
	 * open and its eventual side effects can happen after the turn moved on. A
	 * hook doing I/O must forward this signal and stop publishing when it
	 * aborts.
	 */
	readonly signal?: AbortSignal
}

/**
 * What a hook may say about a tool call beyond letting it run or not. Only
 * `allow` and `ask` exist here: a refusal is `skip`, which always wins.
 *
 * `allow` stands in for the person's yes ONLY on a call that would have been
 * asked about for no reason beyond "it changes something". It never covers a
 * sandbox escape, a path outside the roots, a call the tool declares it always
 * needs approval for, a call a rule sent to review explicitly, or one the tool
 * declares destructive; and it never reopens what a rule denied.
 * `ask` makes the call go to a person even where a rule or the tool's own
 * read-only declaration would have let it through.
 */
export interface PluginHookPermission {
	readonly decision: 'allow' | 'ask'
	readonly reason?: string
}

/** Extra facts a hook may attach to the verdicts that let the work go on. */
export interface PluginHookNotes {
	/**
	 * Text for the model. On a tool event it is appended to what the model
	 * reads of that call; on `user_prompt_submit` it joins the turn's context.
	 */
	readonly context?: string
	/** Stop the turn once the current step is done. `reason` is shown to the operator. */
	readonly halt?: { readonly reason: string }
	/** A warning for the operator, reported through the logger. */
	readonly notice?: string
}

export type PluginHookResult =
	| ({
			action: 'continue'
			permission?: PluginHookPermission
	  } & PluginHookNotes)
	/**
	 * Add to what the model is told, without changing anything else.
	 *
	 * The answer a `user_prompt_submit` hook gives when it has context the
	 * model should have — the branch, the time, a ticket — and no opinion
	 * on the prompt. Accepted on that event only: a tool hook that returns
	 * it is rejected, because a tool result is not a place for context.
	 */
	| { action: 'annotate'; text: string }
	| ({ action: 'skip'; reason: string } & PluginHookNotes)
	| ({
			action: 'modify'
			input: unknown
			permission?: PluginHookPermission
	  } & PluginHookNotes)
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
		case 'annotate':
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

/** Actions the query can interpret for a particular hook event. */
export type PluginHookResultFor<E extends PluginHookEvent> = E extends 'user_prompt_submit'
	? Extract<PluginHookResult, { action: 'continue' | 'annotate' | 'skip' | 'error' }>
	: E extends 'pre_tool_use'
		? Extract<PluginHookResult, { action: 'continue' | 'skip' | 'modify' | 'error' }>
		: E extends 'post_tool_use'
			? Extract<PluginHookResult, { action: 'continue' | 'replace' | 'retry' | 'error' }>
			: E extends 'post_tool_use_failure'
				? Extract<PluginHookResult, { action: 'continue' | 'error' }>
				: E extends 'permission_request'
					? Extract<PluginHookResult, { action: 'continue' | 'skip' }>
					: E extends 'turn_end' | 'subagent_stop' | 'pre_compact'
						? Extract<PluginHookResult, { action: 'continue' | 'skip' | 'error' }>
						: E extends 'turn_interrupt' | 'session_start' | 'session_end' | 'notification'
							? Extract<PluginHookResult, { action: 'continue' }>
							: Extract<PluginHookResult, { action: 'continue' | 'error' }>

/** The event and its handler verdict stay correlated, including in hook arrays. */
export type PluginHookDefinition<E extends PluginHookEvent = PluginHookEvent> =
	E extends PluginHookEvent
		? {
				readonly event: E
				readonly handler: (context: PluginHookContext) => Promise<PluginHookResultFor<E>>
				/**
				 * Lower comes first in the answers. Default 100.
				 *
				 * The hooks of one event start together and none waits for another, so
				 * priority no longer says who runs first; it says whose answer is read
				 * first. The first refusal in that order is the one the model is told,
				 * and of several rewrites the last in that order wins. Ties keep
				 * registration order. Convention: guards below 100, observers above.
				 */
				readonly priority?: number
				/**
				 * Text for the operator's status line while this hook runs. Carried on
				 * the `plugin_hook_executing` event; a host that draws no status line
				 * ignores it.
				 */
				readonly statusMessage?: string
			}
		: never

// ---------------------------------------------------------------------------
// Plugin MCP server config
// ---------------------------------------------------------------------------

export interface PluginMCPServerConfig {
	readonly name: string
	readonly command: string
	readonly args?: readonly string[]
	readonly env?: Readonly<Record<string, string>>
	/** Maximum time to connect and discover this server. Default 10,000 ms. */
	readonly connectTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// Plugin manifest — validated at load time
// ---------------------------------------------------------------------------

export interface PluginManifest {
	readonly name: string
	readonly version: string
	readonly description: string
	readonly author?: string
	/** Plugin-authored request context, present only while this plugin is enabled. */
	readonly instructions?: string
	readonly tools?: readonly string[]
	readonly skills?: readonly string[]
	readonly hooks?: readonly string[]
	readonly mcpServers?: readonly PluginMCPServerConfig[]
	readonly connectors?: readonly string[]
	readonly personas?: readonly string[]
}

export const PluginMCPServerConfigSchema = z
	.object({
		name: z.string().min(1),
		command: z.string().min(1),
		args: z.array(z.string()).optional(),
		env: z.record(z.string()).optional(),
		connectTimeoutMs: z.number().int().positive().max(3_600_000).optional(),
	})
	.strict()

export const PluginManifestSchema = z.object({
	name: z
		.string()
		.min(1)
		.max(PLUGIN_NAME_MAX_LENGTH)
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Plugin name must be lowercase kebab-case'),
	version: z.string().min(1),
	description: z.string().min(1),
	author: z.string().optional(),
	instructions: z.string().min(1).optional(),
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
	| {
			type: 'plugin_installed'
			pluginId: PluginId
			name: string
			scope: PluginScope
	  }
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
