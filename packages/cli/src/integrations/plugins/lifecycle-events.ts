/**
 * The hook events a host fires for things it does itself: changing the model,
 * answering a tool server's question, adding a working folder, reading an
 * instruction file and expanding a command the person typed.
 *
 * Every function here takes the session's hook manager (absent when the
 * session has none) and answers what the hooks decided, in the host's own
 * terms. A hook that fails to run never stops the thing it watches: an error
 * is logged and the event reads as "no objection".
 */
import type {
	MCPElicitationRequest,
	MCPElicitationResult,
	PluginDirectorySource,
	PluginHookContext,
	PluginHookResult,
	PluginInstructionsInfo,
	PluginLifecycleManager,
	PluginModelSwitchInfo,
	PluginPromptExpansionInfo,
} from '@namzu/sdk'

import { cliLogger } from '../../logging.js'

type HookManager = Pick<PluginLifecycleManager, 'executeHooks'>

async function fire(
	manager: HookManager | undefined,
	event: Parameters<PluginLifecycleManager['executeHooks']>[0],
	context: Omit<PluginHookContext, 'pluginId' | 'event'>,
): Promise<readonly PluginHookResult[]> {
	if (manager === undefined) return []
	try {
		return await manager.executeHooks(event, context)
	} catch (error) {
		if (context.signal?.aborted) throw error
		cliLogger().warn('hook event could not run', {
			'namzu.hook.event': event,
			'exception.message': error instanceof Error ? error.message : String(error),
		})
		return []
	}
}

/** What hooks decided about a model switch. `ask` outranks `allow`; a refusal outranks both. */
export type ModelSwitchVerdict =
	| { readonly kind: 'allow' }
	| { readonly kind: 'ask'; readonly reason?: string }
	| { readonly kind: 'deny'; readonly reason: string }

/** `pre_model_switch`: before anything changes. */
export async function preModelSwitch(
	manager: HookManager | undefined,
	sessionId: string,
	info: PluginModelSwitchInfo,
	signal?: AbortSignal,
): Promise<ModelSwitchVerdict> {
	const results = await fire(manager, 'pre_model_switch', {
		sessionId: sessionId as never,
		modelSwitch: info,
		...(signal ? { signal } : {}),
	})
	let verdict: ModelSwitchVerdict = { kind: 'allow' }
	for (const result of results) {
		if (result.action === 'skip') {
			return { kind: 'deny', reason: result.reason }
		}
		if (result.action === 'continue' && result.permission?.decision === 'ask') {
			verdict = {
				kind: 'ask',
				...(result.permission.reason !== undefined ? { reason: result.permission.reason } : {}),
			}
		}
	}
	return verdict
}

/**
 * `post_model_switch`: after the model changed. The text hooks want the model
 * to read with its next request, or `undefined`.
 */
export async function postModelSwitch(
	manager: HookManager | undefined,
	sessionId: string,
	info: PluginModelSwitchInfo,
): Promise<string | undefined> {
	const results = await fire(manager, 'post_model_switch', {
		sessionId: sessionId as never,
		modelSwitch: info,
	})
	const texts: string[] = []
	for (const result of results) {
		if (result.action === 'annotate') texts.push(result.text)
		else if (result.action === 'continue' && result.context) texts.push(result.context)
	}
	return texts.length > 0 ? texts.join('\n') : undefined
}

/** `directory_added`: a folder joined the conversation. */
export async function directoryAdded(
	manager: HookManager | undefined,
	sessionId: string,
	directory: string,
	source: PluginDirectorySource = 'slash_command',
): Promise<void> {
	await fire(manager, 'directory_added', {
		sessionId: sessionId as never,
		directory,
		directorySource: source,
	})
}

/** `instructions_loaded`: an instruction file was read into the session. */
export async function instructionsLoaded(
	manager: HookManager | undefined,
	sessionId: string,
	instructions: PluginInstructionsInfo,
): Promise<void> {
	await fire(manager, 'instructions_loaded', {
		sessionId: sessionId as never,
		instructions,
	})
}

/** `teammate_start`: a teammate joined the team. Observational. */
export async function teammateStart(
	manager: HookManager | undefined,
	sessionId: string,
	team: string,
	name: string,
): Promise<void> {
	await fire(manager, 'teammate_start', {
		sessionId: sessionId as never,
		teammateName: name,
		teamName: team,
	})
}

/** `teammate_stop`: a teammate left the team (shut down, stopped or the team ended). Observational. */
export async function teammateStop(
	manager: HookManager | undefined,
	sessionId: string,
	team: string,
	name: string,
): Promise<void> {
	await fire(manager, 'teammate_stop', {
		sessionId: sessionId as never,
		teammateName: name,
		teamName: team,
	})
}

/**
 * `teammate_idle`: a teammate finished its turn and is about to go idle. The words a hook refused
 * with (exit code 2), or `undefined` when nothing objected: with words, the teammate is sent back to
 * work with them as feedback.
 */
export async function teammateIdle(
	manager: HookManager | undefined,
	sessionId: string,
	team: string,
	name: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const results = await fire(manager, 'teammate_idle', {
		sessionId: sessionId as never,
		teammateName: name,
		teamName: team,
		...(signal ? { signal } : {}),
	})
	const reasons: string[] = []
	for (const result of results)
		if (result.action === 'skip' && result.reason) reasons.push(result.reason)
	return reasons.length > 0 ? reasons.join('\n') : undefined
}

/** What hooks decided about a command that expanded into a prompt. */
export interface PromptExpansionVerdict {
	/** Why the command is stopped, when a hook stopped it. */
	readonly blocked?: string
	/** Text the hooks want the model to read beside the prompt. */
	readonly context?: string
}

/** `user_prompt_expansion`: a typed command became a prompt, before it goes on. */
export async function userPromptExpansion(
	manager: HookManager | undefined,
	sessionId: string,
	expansion: PluginPromptExpansionInfo,
	prompt: string,
): Promise<PromptExpansionVerdict> {
	const results = await fire(manager, 'user_prompt_expansion', {
		sessionId: sessionId as never,
		expansion,
		prompt,
	})
	const contexts: string[] = []
	for (const result of results) {
		if (result.action === 'skip') return { blocked: result.reason }
		if (result.action === 'annotate') contexts.push(result.text)
	}
	return contexts.length > 0 ? { context: contexts.join('\n') } : {}
}

/** The two hook points of a tool server's question. */
export interface ElicitationHooks {
	/**
	 * `elicitation`: before the person is asked. An answer means a hook replied
	 * (or refused) and nobody is asked; `undefined` means ask the person.
	 */
	asked(
		request: MCPElicitationRequest,
		signal: AbortSignal,
	): Promise<MCPElicitationResult | undefined>
	/** `elicitation_result`: the answer about to go to the server, which a hook may replace or refuse. */
	answered(
		request: MCPElicitationRequest,
		result: MCPElicitationResult,
		signal: AbortSignal,
	): Promise<MCPElicitationResult>
}

type Content = Extract<MCPElicitationResult, { action: 'accept' }>['content']

function asResult(answer: {
	readonly action: 'accept' | 'decline' | 'cancel'
	readonly content?: Readonly<Record<string, unknown>>
}): MCPElicitationResult {
	if (answer.action === 'accept') {
		// A server takes strings, numbers, booleans and lists of strings.
		const content: Record<string, string | number | boolean | readonly string[]> = {}
		for (const [key, value] of Object.entries(answer.content ?? {})) {
			if (
				typeof value === 'string' ||
				typeof value === 'number' ||
				typeof value === 'boolean' ||
				(Array.isArray(value) && value.every((item) => typeof item === 'string'))
			) {
				content[key] = value as string | number | boolean | readonly string[]
			}
		}
		return { action: 'accept', content: content as Content }
	}
	return { action: answer.action }
}

export function elicitationHooks(
	manager: () => HookManager | undefined,
	sessionId: () => string,
): ElicitationHooks {
	const info = (request: MCPElicitationRequest) => ({
		serverName: request.serverName,
		message: request.message,
		mode: 'form' as const,
		requestedSchema: request.requestedSchema,
	})
	return {
		async asked(request, signal) {
			const results = await fire(manager(), 'elicitation', {
				sessionId: sessionId() as never,
				elicitation: info(request),
				signal,
			})
			for (const result of results) {
				if (result.action === 'skip') return { action: 'decline' }
			}
			for (const result of results) {
				if (result.action === 'continue' && result.elicitation !== undefined) {
					return asResult(result.elicitation)
				}
			}
			return undefined
		},
		async answered(request, result, signal) {
			const results = await fire(manager(), 'elicitation_result', {
				sessionId: sessionId() as never,
				elicitation: {
					...info(request),
					action: result.action,
					...(result.action === 'accept' ? { content: result.content } : {}),
				},
				signal,
			})
			for (const answer of results) {
				if (answer.action === 'skip') return { action: 'decline' }
			}
			for (const answer of results) {
				if (answer.action === 'continue' && answer.elicitation !== undefined) {
					return asResult(answer.elicitation)
				}
			}
			return result
		},
	}
}

/** What a session offers its host for these events, bound to the session's manager. */
export interface SessionLifecycleHooks {
	preModelSwitch(info: PluginModelSwitchInfo, signal?: AbortSignal): Promise<ModelSwitchVerdict>
	/** Runs `post_model_switch` and keeps what hooks said for the next request this session makes. */
	postModelSwitch(info: PluginModelSwitchInfo): Promise<void>
	userPromptExpansion(
		expansion: PluginPromptExpansionInfo,
		prompt: string,
	): Promise<PromptExpansionVerdict>
}
