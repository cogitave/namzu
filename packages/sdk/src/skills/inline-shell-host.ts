/**
 * How a host runs the commands a skill's text holds, through the machinery it
 * already has.
 *
 * - {@link skillShellHookVerdict} reads what `pre_skill_shell_command` hooks
 *   answered into one verdict for one command.
 * - {@link createSkillShellHook} asks those hooks, and answers `undefined`
 *   when none is attached so nothing is asked of nobody.
 * - {@link createToolSkillShellHost} runs a command as a nested call of the
 *   shell tool from inside another tool (the `skill` tool): the same
 *   authorization gate, the same sandbox and the same tool a model's own call
 *   goes through, and no second executor.
 * - {@link skillShellAllow} turns a skill's `allowed-tools` into a
 *   pre-approval that holds for the one expansion.
 */

import { SkillGrantSet, compileSkillGrant } from '../authorization/skill-grant.js'
import type { PluginLifecycleManager } from '../plugin/lifecycle.js'
import type { SessionId, TurnId } from '../types/ids/index.js'
import type { PluginHookResult, PluginSkillShellInfo } from '../types/plugin/index.js'
import type { ToolContext, ToolDispatchOptions } from '../types/tool/index.js'
import {
	INLINE_SHELL_REASON_CHARS,
	type InlineShellHookVerdict,
	type InlineShellHost,
	type InlineShellOutcome,
	splitShellToolOutput,
} from './inline-shell.js'

/** The tool a skill's commands run in. */
export const SKILL_SHELL_TOOL_NAME = 'bash'

/** The event a host fires before each command, after permission allowed it. */
export const PRE_SKILL_SHELL_COMMAND_EVENT = 'pre_skill_shell_command'

/** The deadline the lifecycle manager gives a hook before it counts as timed out. */
const MANAGER_TIMEOUT_MESSAGE = 'Hook timeout'

type HookManager = Pick<PluginLifecycleManager, 'executeHooks' | 'listHooks'>

/**
 * One command's verdict from every hook's answer.
 *
 * - A stop (`halt`) outranks a refusal, which outranks everything else.
 * - A `skip` refuses this command and nothing else.
 * - An in-process hook that asks for approval, or rewrites the command, is
 *   refused: a load cannot wait for a person and never runs a changed command.
 * - A hook that did not answer, or crashed, refuses the command: nothing says
 *   it is safe. A hook that ran out of time warns and lets it run.
 */
export function skillShellHookVerdict(
	results: readonly PluginHookResult[],
	attached: number,
): InlineShellHookVerdict {
	if (attached > 0 && results.length === 0) {
		return { kind: 'refuse', reason: "the hook didn't answer" }
	}
	const warnings: string[] = []
	const refusals: string[] = []
	let stop: string | undefined
	for (const result of results) {
		const notice = 'notice' in result ? result.notice : undefined
		if (notice) warnings.push(notice)
		switch (result.action) {
			case 'skip':
				refusals.push(result.reason)
				break
			case 'continue':
				if (result.halt !== undefined && stop === undefined) stop = result.halt.reason
				if (result.permission?.decision === 'ask') {
					refusals.push("the hook asked for approval, which a skill can't wait for")
				}
				break
			case 'modify':
				refusals.push("the hook changed the command, which isn't supported here")
				break
			case 'error':
				if (result.message === MANAGER_TIMEOUT_MESSAGE) {
					warnings.push('a hook timed out, so the command ran without its answer')
				} else {
					refusals.push("the hook couldn't run")
				}
				break
			default:
				break
		}
	}
	const warning = warnings.length > 0 ? warnings.join('\n') : undefined
	if (stop !== undefined) return { kind: 'stop', reason: stop }
	if (refusals.length > 0) {
		const reason = refusals.join('; ').slice(0, INLINE_SHELL_REASON_CHARS * 2)
		return { kind: 'refuse', reason, ...(warning ? { warning } : {}) }
	}
	return { kind: 'run', ...(warning ? { warning } : {}) }
}

export interface SkillShellHookOptions {
	readonly manager: HookManager | undefined
	readonly sessionId: string
	readonly turnId?: string
	readonly signal?: AbortSignal
	/** The skill or command, where it came from, and who asked for it. */
	readonly info: PluginSkillShellInfo
	/** The tool name the hook is told. Default `bash`. */
	readonly toolName?: string
}

/**
 * Ask the hooks about one command. `undefined` when the manager has none for
 * the event, so a session with no such hook pays nothing and fires nothing.
 */
export function createSkillShellHook(
	options: SkillShellHookOptions,
): ((command: string, toolUseId: string) => Promise<InlineShellHookVerdict>) | undefined {
	const manager = options.manager
	if (manager === undefined) return undefined
	const attached = manager
		.listHooks()
		.filter((hook) => hook.event === PRE_SKILL_SHELL_COMMAND_EVENT).length
	if (attached === 0) return undefined
	const toolName = options.toolName ?? SKILL_SHELL_TOOL_NAME
	return async (command, toolUseId) => {
		try {
			const results = await manager.executeHooks(PRE_SKILL_SHELL_COMMAND_EVENT, {
				sessionId: options.sessionId as SessionId,
				...(options.turnId !== undefined ? { turnId: options.turnId as TurnId } : {}),
				toolName,
				toolInput: { command },
				toolCallId: toolUseId,
				skillShell: options.info,
				...(options.signal ? { signal: options.signal } : {}),
			})
			return skillShellHookVerdict(results, attached)
		} catch (error) {
			if (options.signal?.aborted) throw error
			return { kind: 'refuse', reason: "the hook couldn't run" }
		}
	}
}

/**
 * The pre-approval a skill's `allowed-tools` gives to its own commands, for
 * one expansion. Only entries for the shell tool count; any other entry is
 * not read here. Absent when the skill grants the shell tool nothing.
 */
export function skillShellAllow(
	allowedTools: readonly string[] | undefined,
	options: { readonly skillDirectory?: string; readonly toolName?: string } = {},
): ToolDispatchOptions['allow'] | undefined {
	if (allowedTools === undefined || allowedTools.length === 0) return undefined
	const toolName = options.toolName ?? SKILL_SHELL_TOOL_NAME
	const compiled = compileSkillGrant(allowedTools, {
		resolveTool: (name) =>
			name.toLowerCase() === toolName ? { name: toolName, commandArgument: 'command' } : undefined,
		...(options.skillDirectory ? { skillDirectory: options.skillDirectory } : {}),
	})
	if (compiled.entries.length === 0) return undefined
	const held = new SkillGrantSet()
	held.grant('inline-shell', compiled)
	return (call) => held.coveringSkill(call) !== undefined
}

/** Strip the tool's closing `Error: ...` line off a failed result's text. */
function withoutErrorLine(text: string): string {
	const at = text.lastIndexOf('\n\nError: ')
	if (at !== -1) return text.slice(0, at)
	return text.startsWith('Error: ') ? '' : text
}

export interface ToolSkillShellHostOptions {
	readonly context: ToolContext
	readonly allow?: ToolDispatchOptions['allow']
	readonly toolName?: string
}

/**
 * A host that runs each command by dispatching the shell tool from inside the
 * tool that is loading the text. A command a rule does not allow is refused
 * with the rule's reason, because a person cannot be asked from inside
 * another tool's call.
 */
export function createToolSkillShellHost(options: ToolSkillShellHostOptions): InlineShellHost {
	const toolName = options.toolName ?? SKILL_SHELL_TOOL_NAME
	const dispatch = options.context.dispatchTool
	return {
		async run(command, beforeRun) {
			if (dispatch === undefined) {
				return {
					kind: 'denied',
					reason: 'this turn cannot run a tool from inside another one',
				}
			}
			let hook: Exclude<InlineShellHookVerdict, { kind: 'run' }> | undefined
			let result: Awaited<ReturnType<typeof dispatch>>
			try {
				result = await dispatch(
					toolName,
					{ command },
					{
						...(options.allow ? { allow: options.allow } : {}),
						beforeRun: async () => {
							const verdict = await beforeRun()
							if (verdict.kind === 'run') return undefined
							hook = verdict
							return 'refused by a hook'
						},
					},
				)
			} catch (error) {
				if (options.context.abortSignal.aborted) {
					return { kind: 'ran', stdout: '', stderr: '', exitCode: null, interrupted: true }
				}
				throw error
			}
			if (hook !== undefined) return { kind: 'hook', verdict: hook }
			return outcomeOf(result)
		},
	}
}

/** A shell tool result as the host's outcome of one command. */
export function outcomeOf(result: {
	readonly success: boolean
	readonly output: string
	readonly error?: string
	readonly data?: unknown
}): InlineShellOutcome {
	const data =
		result.data !== null && typeof result.data === 'object'
			? (result.data as Record<string, unknown>)
			: undefined
	const exitCode = typeof data?.exitCode === 'number' ? data.exitCode : undefined
	const ran = data !== undefined && ('exitCode' in data || 'timedOut' in data)
	if (!ran && !result.success) {
		return { kind: 'denied', reason: deniedReason(result.error ?? result.output) }
	}
	// Through a nested dispatch a failure's text is in `error` (output and the closing line
	// joined); from the tool itself it is in `output`, with the closing line in `error`.
	const text = result.success
		? result.output
		: result.output !== ''
			? result.output
			: withoutErrorLine(result.error ?? '')
	const { stdout, stderr } = splitShellToolOutput(text)
	if (result.success) {
		return { kind: 'ran', stdout, stderr, exitCode: exitCode ?? 0 }
	}
	return {
		kind: 'ran',
		stdout,
		stderr,
		exitCode: exitCode ?? null,
	}
}

/** The words after `Tool "x" was not executed.` when that is how the refusal begins. */
function deniedReason(text: string): string {
	const trimmed = text.replace(/^Error:\s*/, '')
	const match = /^Tool "[^"]*" was not executed\.\s*/.exec(trimmed)
	return (match ? trimmed.slice(match[0].length) : trimmed).trim() || 'refused'
}
