/**
 * The shell commands a skill or a custom command holds, run while its text
 * loads, for the loads that happen outside a model turn: a command the person
 * typed, a headless prompt, a skill preloaded into a sub-agent.
 *
 * The model's own `skill` tool runs them as nested calls of the shell tool
 * inside its turn (`@namzu/sdk` `createToolSkillShellHost`). With no turn to
 * nest in, this does the same steps in the same order, with the same
 * parts and no second shell:
 *
 * 1. the session's authorization gate decides (the operator's rules and the
 *    dangerous-command floor, exactly as for a model's call). A command the
 *    gate denies, or would send to a person, fails the load with the reason:
 *    a load cannot ask. A skill's `allowed-tools` answers only a command no
 *    rule decided, for this one load;
 *    A command that reaches a protected path, a removal the floor stops or a
 *    path outside the working folders then fails the load too, as the
 *    executor's own review does for a nested call, whatever the rules say;
 * 2. `pre_skill_shell_command` hooks, when one is attached;
 * 3. the shell tool itself, in the sandbox the session runs in.
 */

import { randomUUID } from 'node:crypto'
import {
	type AuthorizationGate,
	type InlineShellBlock,
	type InlineShellHost,
	type PluginLifecycleManager,
	type Sandbox,
	type SandboxProvider,
	type SessionId,
	type ToolContext,
	type ToolDefinition,
	type TurnId,
	createSkillShellHook,
	expandInlineShell,
	findInlineShell,
	getBuiltinTools,
	parseAllowedTools,
	shellLineEscalation,
	skillShellAllow,
	skillShellOutcomeOf,
} from '@namzu/sdk'

/** Where a skill or command came from, as far as running its commands is concerned. */
export type SkillShellOrigin = 'user' | 'project' | 'plugin' | 'system'

/**
 * Why commands from this origin may not run at all, before any is tried. A
 * project's own text runs only in a folder the person trusted; the person's own,
 * a plugin's and the ones shipped with Namzu do not wait on it. Nothing from a
 * tool server or another remote source is ever run (`remote`): no origin here
 * names one, and a caller that has one passes it as `remote`.
 */
export function shellBlockFor(
	origin: SkillShellOrigin | 'remote',
	trusted: boolean,
): InlineShellBlock | undefined {
	if (origin === 'remote') return 'remote'
	if (origin === 'project' && !trusted) return 'untrusted'
	return undefined
}

export interface SkillShellRequest {
	/** The text, with its arguments and variables already put in (escaped). */
	readonly text: string
	/** The skill or command, without the slash. */
	readonly name: string
	readonly origin: SkillShellOrigin | 'remote'
	/** `user` for a typed command, `other` for a preload or a headless prompt. */
	readonly invokedBy: 'user' | 'other'
	/** The skill's `allowed-tools`, as written. */
	readonly allowedTools?: string
	/** The skill's folder, for `${NAMZU_SKILL_DIR}` in an `allowed-tools` pattern. */
	readonly directory?: string
	readonly signal?: AbortSignal
}

export interface SessionSkillShell {
	/**
	 * The text with each command's output in its place. Throws
	 * `InlineShellError` when a command fails, is refused by the permission
	 * rules, or a hook stops the load; its message is for the person.
	 */
	expand(request: SkillShellRequest): Promise<string>
}

export interface SessionSkillShellDeps {
	readonly cwd: () => string
	/** The folders a command may reach: the working directory, then the added ones. */
	readonly roots?: () => readonly string[]
	/** `disableSkillShellExecution`, read at each load. */
	readonly disabled: () => boolean
	/** Whether the project folder is trusted. */
	readonly trusted: () => boolean
	/** The session's gate, built from the rules as they stand now. */
	readonly gate: () => AuthorizationGate
	readonly hooks: () => Pick<PluginLifecycleManager, 'executeHooks' | 'listHooks'> | undefined
	readonly sessionId: () => string
	/** The sandbox the session's commands run in; absent runs on the host. */
	readonly sandbox?: () =>
		| {
				readonly provider: SandboxProvider
				readonly workspace: 'working-directory' | 'ephemeral'
				readonly additionalDirectories?: readonly string[]
		  }
		| undefined
	/** A line for the person: a refused command, a hook's own message. */
	readonly warn?: (line: string) => void
	readonly env?: () => Record<string, string | undefined>
}

export function createSessionSkillShell(deps: SessionSkillShellDeps): SessionSkillShell {
	const bash = getBuiltinTools().find((tool) => tool.name === 'bash') as ToolDefinition | undefined
	return {
		async expand(request) {
			if (findInlineShell(request.text).length === 0) return request.text
			const block = deps.disabled() ? 'off' : shellBlockFor(request.origin, deps.trusted())
			if (block !== undefined || bash === undefined) {
				return expandInlineShell(request.text, {
					host: {
						run: async () => ({ kind: 'denied', reason: 'the shell tool is not available' }),
					},
					commandName: request.name,
					block: block ?? 'off',
				})
			}
			const signal = request.signal ?? new AbortController().signal
			const allow = skillShellAllow(parseAllowedTools(request.allowedTools), {
				...(request.directory ? { skillDirectory: request.directory } : {}),
			})
			const hook = createSkillShellHook({
				manager: deps.hooks(),
				sessionId: deps.sessionId(),
				signal,
				info: {
					commandName: request.name,
					commandSource: request.origin,
					invokedBy: request.invokedBy,
				},
			})
			const sandboxPlan = deps.sandbox?.()
			let sandbox: Sandbox | undefined
			const turnId = randomUUID() as TurnId
			const run: InlineShellHost['run'] = async (command, beforeRun) => {
				const input = { command }
				const verdict = deps.gate().evaluate({
					toolName: 'bash',
					toolInput: input,
					toolDef: bash,
					commandDialect: bash.commandDialect?.({ sandboxed: sandboxPlan !== undefined }) ?? 'sh',
				})
				if (verdict.decision === 'deny') {
					return { kind: 'denied', reason: verdict.reason }
				}
				if (verdict.decision === 'review') {
					const granted = verdict.matchedRule === null && allow?.({ name: 'bash', input }) === true
					if (!granted) {
						return {
							kind: 'denied',
							reason: `${verdict.reason}. A command in a skill cannot wait for approval, so it needs an allow rule (or the skill's allowed-tools) for this command.`,
						}
					}
				}
				if (bash.requiresApproval?.(input as never) === true) {
					return {
						kind: 'denied',
						reason: 'this command needs the person’s approval, which a skill cannot wait for',
					}
				}
				// What the line reaches past the roots (a protected path, a removal, an outside
				// path) goes to a person for a model's call and no rule or grant lifts it; a load
				// has no person, so it fails, as the nested call does.
				const reach = await shellLineEscalation(command, {
					roots: deps.roots?.() ?? [deps.cwd()],
					cwd: deps.cwd(),
					sandboxed: sandboxPlan !== undefined,
					dialect: bash.commandDialect?.({ sandboxed: sandboxPlan !== undefined }) ?? 'sh',
				})
				if (reach !== undefined) {
					return {
						kind: 'denied',
						reason: `${reach}, which needs the person’s review, and a skill cannot wait for one. Run it as a direct call instead.`,
					}
				}
				const checked = await beforeRun()
				if (checked.kind !== 'run') return { kind: 'hook', verdict: checked }
				if (sandboxPlan !== undefined && sandbox === undefined) {
					sandbox = await sandboxPlan.provider.create({
						signal,
						...(sandboxPlan.workspace === 'working-directory'
							? {
									workingDirectory: deps.cwd(),
									...(sandboxPlan.additionalDirectories?.length
										? { additionalDirectories: sandboxPlan.additionalDirectories }
										: {}),
								}
							: {}),
					})
				}
				const context = {
					sessionId: deps.sessionId() as SessionId,
					turnId,
					workingDirectory: deps.cwd(),
					abortSignal: signal,
					env: { ...(deps.env?.() ?? process.env) },
					log: () => {},
					...(sandbox ? { sandbox } : {}),
				} as unknown as ToolContext
				try {
					// The tool's own reading of its input, as the executor does it: the deadline and the
					// other defaults the schema fills in.
					const result = await bash.execute(bash.inputSchema.parse(input) as never, context)
					return skillShellOutcomeOf(result)
				} catch (error) {
					if (signal.aborted) {
						return { kind: 'ran', stdout: '', stderr: '', exitCode: null, interrupted: true }
					}
					throw error
				}
			}
			try {
				return await expandInlineShell(request.text, {
					host: { run },
					commandName: request.name,
					...(hook
						? { hook: (command: string) => hook(command, `skillshell_${randomUUID()}`) }
						: {}),
					...(deps.warn ? { warn: deps.warn } : {}),
					signal,
				})
			} finally {
				await sandbox?.destroy().catch(() => undefined)
			}
		},
	}
}

/** A session with nothing to run commands in: every command is refused with the reason. */
export const NO_SKILL_SHELL: SessionSkillShell = {
	expand: (request) =>
		expandInlineShell(request.text, {
			host: {
				run: async () => ({
					kind: 'denied',
					reason: 'this session has no shell to run it in',
				}),
			},
			commandName: request.name,
		}),
}
