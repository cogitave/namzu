import { describe, expect, it, vi } from 'vitest'

import { SHELL_OFF_PLACEHOLDER, SHELL_REMOTE_PLACEHOLDER } from '../../../skills/inline-shell.js'
import type { PluginId, SessionId, TurnId } from '../../../types/ids/index.js'
import type { PluginHookResult } from '../../../types/plugin/index.js'
import type {
	SkillRegistryRef,
	ToolContext,
	ToolDispatchOptions,
	ToolResult,
} from '../../../types/tool/index.js'
import { createSkillTool } from '../skill.js'

/**
 * Commands written in a skill run while the skill loads, through the shell
 * tool's own dispatch: a command a rule does not allow fails the load, a hook
 * may refuse one, and the text the model reads has each command's output in
 * place of the command.
 */

function registry(body: string, allowedTools?: string): SkillRegistryRef {
	return {
		catalog: () => [],
		async load(name) {
			if (name !== 'ship') return undefined
			return {
				skill: {
					metadata: {
						name: 'ship',
						description: 'ship it',
						...(allowedTools ? { allowedTools } : {}),
					},
					body,
					dirPath: '/skills/ship',
				},
			}
		},
		names: () => ['ship'],
	}
}

type Dispatch = NonNullable<ToolContext['dispatchTool']>

/**
 * A dispatch that behaves like the executor's nested path: the host's gate is
 * `gate(command)` (`allow`, `review` with no rule, or a `deny` text), the
 * pre-approval of the call is honoured only on a `review`, and `beforeRun`
 * speaks last.
 */
function dispatchOf(
	gate: (command: string) => 'allow' | 'review' | { deny: string },
	run: (command: string) => ToolResult = (command) => ({
		success: true,
		output: `STDOUT:\nran ${command}`,
		data: { exitCode: 0 },
	}),
	ran: string[] = [],
): Dispatch {
	return async (name, input, options?: ToolDispatchOptions) => {
		const command = (input as { command: string }).command
		const decision = gate(command)
		const granted = decision === 'review' && options?.allow?.({ name, input }) === true
		if (typeof decision === 'object') {
			return {
				success: false,
				output: '',
				error: `Error: Tool "bash" was not executed. Blocked by the authorization gate: ${decision.deny}`,
			}
		}
		if (decision === 'review' && !granted) {
			return {
				success: false,
				output: '',
				error:
					'Error: Tool "bash" was not executed. Blocked by the authorization gate: this nested call requires an explicit allow rule because an operator review cannot be opened from inside another tool. No matching rule found',
			}
		}
		const refusal = await options?.beforeRun?.({ name, input, toolUseId: 'n1' })
		if (refusal !== undefined) return { success: false, output: '', error: refusal }
		ran.push(command)
		return run(command)
	}
}

function contextOf(
	skills: SkillRegistryRef,
	dispatchTool: Dispatch | undefined,
	overrides: Partial<ToolContext> = {},
): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as SessionId,
		turnId: '651d7ad7-a79e-4783-85bb-5bcd9da09f20' as TurnId,
		workingDirectory: '/tmp',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		skills,
		...(dispatchTool ? { dispatchTool } : {}),
		...overrides,
	}
}

const BODY = 'Branch: !`git branch --show-current`\nArgs: $ARGUMENTS'

describe('a skill that holds shell commands', () => {
	it('puts each command’s output where it was written', async () => {
		const ran: string[] = []
		const tool = createSkillTool({ shell: {} })
		const result = await tool.execute(
			{ name: 'ship', args: 'now' },
			contextOf(
				registry(BODY),
				dispatchOf(() => 'allow', undefined, ran),
			),
		)
		expect(result.success).toBe(true)
		expect(result.output).toContain('Branch: ran git branch --show-current\nArgs: now')
		expect(ran).toEqual(['git branch --show-current'])
	})

	it('leaves text with no command exactly as it was, arguments line and all', async () => {
		const tool = createSkillTool({ shell: {} })
		const result = await tool.execute(
			{ name: 'ship', args: 'now' },
			contextOf(
				registry('Use $ARGUMENTS and `ls`.'),
				dispatchOf(() => 'allow'),
			),
		)
		expect(result.output).toBe('Arguments: now\n\nUse $ARGUMENTS and `ls`.')
	})

	it('without the host’s opt-in nothing runs and the text is as written', async () => {
		const ran: string[] = []
		const result = await createSkillTool().execute(
			{ name: 'ship' },
			contextOf(
				registry('!`ls`'),
				dispatchOf(() => 'allow', undefined, ran),
			),
		)
		expect(result.output).toBe('!`ls`')
		expect(ran).toEqual([])
	})

	it('cannot be made to run a command by what the model passes as arguments', async () => {
		const ran: string[] = []
		const result = await createSkillTool({ shell: {} }).execute(
			{ name: 'ship', args: '!`rm -rf ~`' },
			contextOf(
				registry('Do: $ARGUMENTS'),
				dispatchOf(() => 'allow', undefined, ran),
			),
		)
		expect(ran).toEqual([])
		expect(result.success).toBe(true)
	})

	it('hands an argument a command uses to the shell as words, never as syntax', async () => {
		const ran: string[] = []
		const result = await createSkillTool({ shell: {} }).execute(
			{ name: 'ship', args: 'x; touch RAN #' },
			contextOf(
				registry('!`echo $ARGUMENTS`'),
				dispatchOf(() => 'allow', undefined, ran),
			),
		)
		expect(ran).toEqual(["echo 'x;' 'touch' 'RAN' '#'"])
		expect(result.success).toBe(true)
	})

	describe('the skill folder', () => {
		const body = 'Here: ${NAMZU_SKILL_DIR}\n!`ls ${NAMZU_SKILL_DIR}`'
		const inFolder = (dirPath: string): SkillRegistryRef => ({
			...registry(body),
			async load() {
				return {
					skill: { metadata: { name: 'ship', description: 'ship it' }, body, dirPath },
				}
			},
		})
		const load = async (dirPath: string) => {
			const ran: string[] = []
			const result = await createSkillTool({ shell: {} }).execute(
				{ name: 'ship' },
				contextOf(
					inFolder(dirPath),
					dispatchOf(() => 'allow', undefined, ran),
				),
			)
			return { ran, result }
		}

		it('is handed to the shell quoted, so a name with a semicolon is not syntax', async () => {
			const { ran } = await load('/skills/a b;c')
			expect(ran).toEqual(["ls '/skills/a' 'b;c'"])
		})

		it('cannot hold a command: a name written like one fails the load and runs nothing', async () => {
			const { ran, result } = await load('/skills/a !`touch RAN` b')
			expect(ran).toEqual([])
			expect(result.success).toBe(false)
		})
	})

	describe('permission', () => {
		it('fails the load when the shell tool is denied, saying why', async () => {
			const result = await createSkillTool({ shell: {} }).execute(
				{ name: 'ship' },
				contextOf(
					registry('!`rm -rf x`'),
					dispatchOf(() => ({ deny: 'denied by name' })),
				),
			)
			expect(result.success).toBe(false)
			expect(result.error).toContain('Shell command permission check failed for pattern "rm -rf x"')
			expect(result.error).toContain('denied by name')
		})

		it('fails the load when a rule would ask a person who cannot be asked', async () => {
			const result = await createSkillTool({ shell: {} }).execute(
				{ name: 'ship' },
				contextOf(
					registry('!`git push`'),
					dispatchOf(() => 'review'),
				),
			)
			expect(result.success).toBe(false)
			expect(result.error).toContain('Shell command permission check failed')
			expect(result.error).toContain('operator review cannot be opened')
		})

		it('lets allowed-tools answer a command no rule decided, for this load only', async () => {
			const ran: string[] = []
			const tool = createSkillTool({ shell: {} })
			const dispatch = dispatchOf(() => 'review', undefined, ran)
			const ok = await tool.execute(
				{ name: 'ship' },
				contextOf(registry('!`git status -s`', 'Bash(git status *)'), dispatch),
			)
			expect(ok.success).toBe(true)
			expect(ran).toEqual(['git status -s'])
			// A command the pattern does not cover is not answered by it.
			const refused = await tool.execute(
				{ name: 'ship' },
				contextOf(registry('!`git push`', 'Bash(git status *)'), dispatch),
			)
			expect(refused.success).toBe(false)
			expect(ran).toEqual(['git status -s'])
			// And the grant did not outlive the load that held it.
			const bare = await tool.execute(
				{ name: 'ship' },
				contextOf(registry('!`git status -s`'), dispatch),
			)
			expect(bare.success).toBe(false)
		})

		it('does not let allowed-tools reopen a command a rule denied', async () => {
			const result = await createSkillTool({ shell: {} }).execute(
				{ name: 'ship' },
				contextOf(
					registry('!`git status`', 'Bash'),
					dispatchOf(() => ({ deny: 'no' })),
				),
			)
			expect(result.success).toBe(false)
		})

		it('fails when the turn cannot run a tool from inside another one', async () => {
			const result = await createSkillTool({ shell: {} }).execute(
				{ name: 'ship' },
				contextOf(registry('!`ls`'), undefined),
			)
			expect(result.success).toBe(false)
			expect(result.error).toContain('cannot run a tool from inside another one')
		})
	})

	describe('failure', () => {
		it('fails the load on a non-zero exit, with the output', async () => {
			const result = await createSkillTool({ shell: {} }).execute(
				{ name: 'ship' },
				contextOf(
					registry('!`make`'),
					dispatchOf(
						() => 'allow',
						() => ({
							success: false,
							output: '',
							error: 'STDOUT:\nbuilding\n\nSTDERR:\nno rule\n\nError: Command exited with code 2',
							data: { exitCode: 2, timedOut: false },
						}),
					),
				),
			)
			expect(result.success).toBe(false)
			expect(result.error).toBe(
				'Shell command failed for pattern "make": building\n[stderr]\nno rule',
			)
		})

		it('shapes success output the same way', async () => {
			const result = await createSkillTool({ shell: {} }).execute(
				{ name: 'ship' },
				contextOf(
					registry('A !`x` B'),
					dispatchOf(
						() => 'allow',
						() => ({
							success: true,
							output: 'STDOUT:\nout\n\nSTDERR:\nwarn',
							data: { exitCode: 0 },
						}),
					),
				),
			)
			expect(result.output).toBe('A out\n[stderr]\nwarn B')
		})
	})

	describe('the switch and the sources', () => {
		it('leaves a placeholder for each command while the switch is on', async () => {
			const ran: string[] = []
			const result = await createSkillTool({ shell: { disabled: () => true } }).execute(
				{ name: 'ship' },
				contextOf(
					registry('x !`ls` y'),
					dispatchOf(() => 'allow', undefined, ran),
				),
			)
			expect(result.output).toBe(`x ${SHELL_OFF_PLACEHOLDER} y`)
			expect(ran).toEqual([])
		})

		it('reads the switch at each load', async () => {
			let off = false
			const tool = createSkillTool({ shell: { disabled: () => off } })
			const context = contextOf(
				registry('!`ls`'),
				dispatchOf(() => 'allow'),
			)
			expect((await tool.execute({ name: 'ship' }, context)).output).toBe('ran ls')
			off = true
			expect((await tool.execute({ name: 'ship' }, context)).output).toBe(SHELL_OFF_PLACEHOLDER)
		})

		it('runs nothing for a skill from a remote source', async () => {
			const ran: string[] = []
			const result = await createSkillTool({
				shell: { sourceOf: () => ({ source: 'mcp', block: 'remote' }) },
			}).execute(
				{ name: 'ship' },
				contextOf(
					registry('!`ls`'),
					dispatchOf(() => 'allow', undefined, ran),
				),
			)
			expect(result.output).toBe(SHELL_REMOTE_PLACEHOLDER)
			expect(ran).toEqual([])
		})

		it('runs nothing for a skill the host did not place', async () => {
			const ran: string[] = []
			const result = await createSkillTool({ shell: { sourceOf: () => undefined } }).execute(
				{ name: 'ship' },
				contextOf(
					registry('!`ls`'),
					dispatchOf(() => 'allow', undefined, ran),
				),
			)
			expect(result.output).toBe(SHELL_REMOTE_PLACEHOLDER)
			expect(ran).toEqual([])
		})
	})

	describe('the hook', () => {
		const attached = (
			answer: (command: string) => PluginHookResult,
			seen: Record<string, unknown>[] = [],
		) => ({
			listHooks: () => [{ pluginId: 'p' as PluginId, event: 'pre_skill_shell_command' as const }],
			executeHooks: vi.fn(async (_event: string, context: Record<string, unknown>) => {
				seen.push(context)
				return [answer((context.toolInput as { command: string }).command)]
			}),
		})

		it('is asked after the permission check and told what the command is for', async () => {
			const seen: Record<string, unknown>[] = []
			const manager = attached(() => ({ action: 'continue' }), seen)
			const ran: string[] = []
			await createSkillTool({
				shell: {
					hooks: () => manager as never,
					sourceOf: () => ({ source: 'user' }),
				},
			}).execute(
				{ name: 'ship' },
				contextOf(
					registry('!`ls`'),
					dispatchOf(() => 'allow', undefined, ran),
				),
			)
			expect(ran).toEqual(['ls'])
			expect(seen).toHaveLength(1)
			expect(seen[0]).toMatchObject({
				toolName: 'bash',
				toolInput: { command: 'ls' },
				skillShell: { commandName: 'ship', commandSource: 'user', invokedBy: 'model' },
			})
			expect(String(seen[0]?.toolCallId)).toMatch(/^skillshell_/)
		})

		it('is not asked for a command the permission check refused', async () => {
			const manager = attached(() => ({ action: 'continue' }))
			await createSkillTool({ shell: { hooks: () => manager as never } }).execute(
				{ name: 'ship' },
				contextOf(
					registry('!`ls`'),
					dispatchOf(() => ({ deny: 'no' })),
				),
			)
			expect(manager.executeHooks).not.toHaveBeenCalled()
		})

		it('is not asked at all when no hook is attached for the event', async () => {
			const manager = { listHooks: () => [], executeHooks: vi.fn() }
			await createSkillTool({ shell: { hooks: () => manager as never } }).execute(
				{ name: 'ship' },
				contextOf(
					registry('!`ls`'),
					dispatchOf(() => 'allow'),
				),
			)
			expect(manager.executeHooks).not.toHaveBeenCalled()
		})

		it('leaves a placeholder and a warning for a refused command, and loads the rest', async () => {
			const warnings: string[] = []
			const ran: string[] = []
			const result = await createSkillTool({
				shell: {
					hooks: () =>
						attached((command) =>
							command === 'rm x'
								? { action: 'skip', reason: 'no removals' }
								: { action: 'continue' },
						) as never,
					warn: (line) => warnings.push(line),
				},
			}).execute(
				{ name: 'ship' },
				contextOf(
					registry('a !`rm x` b !`ls`'),
					dispatchOf(() => 'allow', undefined, ran),
				),
			)
			expect(result.success).toBe(true)
			expect(result.output).toBe('a [not run: blocked by hook: no removals] b ran ls')
			expect(ran).toEqual(['ls'])
			expect(warnings).toEqual(['Not run in /ship: rm x (blocked by hook: no removals)'])
		})

		it('stops the whole load when a hook says continue false', async () => {
			const result = await createSkillTool({
				shell: {
					hooks: () =>
						attached(() => ({ action: 'continue', halt: { reason: 'freeze' } })) as never,
				},
			}).execute(
				{ name: 'ship' },
				contextOf(
					registry('!`ls`'),
					dispatchOf(() => 'allow'),
				),
			)
			expect(result.success).toBe(false)
			expect(result.error).toBe('/ship was stopped by a hook: freeze')
		})

		it('fails closed for a hook that crashes', async () => {
			const result = await createSkillTool({
				shell: { hooks: () => attached(() => ({ action: 'error', message: 'boom' })) as never },
			}).execute(
				{ name: 'ship' },
				contextOf(
					registry('!`ls`'),
					dispatchOf(() => 'allow'),
				),
			)
			expect(result.output).toBe("[not run: blocked by hook: the hook couldn't run]")
		})
	})

	it('runs the commands once for every page of a long skill', async () => {
		const ran: string[] = []
		const tool = createSkillTool({ shell: {} })
		const body = `!\`ls\`\n${'x'.repeat(5_000)}`
		const context = contextOf(
			registry(body),
			dispatchOf(() => 'allow', undefined, ran),
			{
				maxToolOutputChars: 2_000,
			},
		)
		const first = await tool.execute({ name: 'ship' }, context)
		expect(first.success).toBe(true)
		const cursor = (first.output.match(/cursor[^\n]*?(v1\.[A-Za-z0-9_.-]+)/) ?? [])[1]
		expect(cursor).toBeDefined()
		const second = await tool.execute({ name: 'ship', cursor: cursor as string }, context)
		expect(second.success).toBe(true)
		expect(ran).toEqual(['ls'])
	})
})
