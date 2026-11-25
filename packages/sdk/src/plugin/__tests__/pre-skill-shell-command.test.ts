/**
 * `pre_skill_shell_command`: the hook that sees each shell command a skill or a
 * custom command is about to run while its text loads.
 *
 * Three layers. The shell mapping is pure, so every reply and every failure of
 * the hook is pinned without a process. The reading of what hooks answered is
 * pure too. One test runs the real lifecycle manager with a hook that never
 * answers, on fake timers, because "no answer in time" is a fact about the
 * manager's deadline and not about the mapping.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSkillShellHook, skillShellHookVerdict } from '../../skills/inline-shell-host.js'
import type { PluginId, SessionId } from '../../types/ids/index.js'
import type { PluginHookContext, PluginHookResult } from '../../types/plugin/index.js'
import { asSessionId } from '../../utils/id.js'
import { PluginLifecycleManager } from '../lifecycle.js'
import {
	SHELL_HOOK_EVENTS,
	SHELL_HOOK_PASCAL_EVENT_NAMES,
	createShellHook,
	shellHookPayload,
	shellHookVerdict,
} from '../shell-hook.js'

const SESSION = '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b'
const ok = { exitCode: 0, timedOut: false, stdout: '', stderr: '' }
const json = (value: unknown) => ({ ...ok, stdout: JSON.stringify(value) })
const entry = { command: 'x' }
const run = (outcome: object, handler: object = entry) =>
	shellHookVerdict('pre_skill_shell_command', handler as never, outcome as never)
const specific = (fields: Record<string, unknown>) =>
	json({
		hookSpecificOutput: { hookEventName: 'PreSkillShellCommand', ...fields },
	})

describe('the event', () => {
	it('is a shell hook event with its written name', () => {
		expect(SHELL_HOOK_EVENTS).toContain('pre_skill_shell_command')
		expect(SHELL_HOOK_PASCAL_EVENT_NAMES.pre_skill_shell_command).toBe('PreSkillShellCommand')
	})

	it('sends the command, its tool, a fresh id and where it came from', () => {
		const payload = JSON.parse(
			shellHookPayload({
				event: 'pre_skill_shell_command',
				cwd: '/p',
				sessionId: SESSION,
				toolName: 'bash',
				toolNames: 'written',
				toolCallId: 'skillshell_1',
				toolInput: { command: 'git status' },
				skillShell: { commandName: 'review', commandSource: 'project', invokedBy: 'user' },
			}),
		)
		expect(payload).toMatchObject({
			hook_event_name: 'PreSkillShellCommand',
			tool_name: 'Bash',
			tool_use_id: 'skillshell_1',
			tool_input: { command: 'git status' },
			command_name: 'review',
			command_source: 'project',
			invoked_by: 'user',
		})
	})

	it('leaves command_source out when it is not known', () => {
		const payload = JSON.parse(
			shellHookPayload({
				event: 'pre_skill_shell_command',
				cwd: '/p',
				sessionId: SESSION,
				skillShell: { commandName: 'x', invokedBy: 'other' },
			}),
		)
		expect(payload.command_source).toBeUndefined()
		expect(payload.invoked_by).toBe('other')
	})
})

describe('replies', () => {
	it('exit 0 lets the command run', () => {
		expect(run(ok)).toEqual({ action: 'continue' })
	})

	it('exit 2 refuses it and the reason is stderr', () => {
		expect(run({ ...ok, exitCode: 2, stderr: 'not in this repo\n' })).toEqual({
			action: 'skip',
			reason: 'not in this repo',
		})
	})

	it('any other exit code warns and lets it run', () => {
		expect(run({ ...ok, exitCode: 1, stderr: 'oops' })).toMatchObject({
			action: 'continue',
			notice: expect.stringContaining('exited with 1'),
		})
	})

	it.each([
		['a plain allow', specific({ permissionDecision: 'allow' }), { action: 'continue' }],
		[
			'a deny with its reason',
			specific({ permissionDecision: 'deny', permissionDecisionReason: 'no pushes' }),
			{ action: 'skip', reason: 'no pushes' },
		],
		[
			'a deny with no reason',
			specific({ permissionDecision: 'deny' }),
			{ action: 'skip', reason: 'Blocked by hook' },
		],
		[
			'an ask, which a load cannot wait for',
			specific({ permissionDecision: 'ask', permissionDecisionReason: 'check it' }),
			{
				action: 'skip',
				reason: "check it (the hook asked for approval, which a skill can't wait for)",
			},
		],
		[
			'a defer',
			specific({ permissionDecision: 'defer' }),
			{ action: 'skip', reason: "the hook asked for approval, which a skill can't wait for" },
		],
		[
			'a rewritten command, which is never applied',
			specific({ updatedInput: { command: 'ls' } }),
			{ action: 'skip', reason: "the hook changed the command, which isn't supported here" },
		],
		[
			'a change of permissions',
			specific({ updatedPermissions: [] }),
			{
				action: 'skip',
				reason: "the hook asked to change permissions, which isn't supported here",
			},
		],
		[
			'a top-level block',
			json({ decision: 'block', reason: 'later' }),
			{ action: 'skip', reason: 'later' },
		],
		[
			'continue false, which stops the whole load',
			json({ continue: false, stopReason: 'enough' }),
			{ action: 'continue', halt: { reason: 'enough' } },
		],
		[
			'a system message beside an allow',
			json({ systemMessage: 'heads up' }),
			{ action: 'continue', notice: 'heads up' },
		],
		[
			'a system message beside a refusal',
			{ ...json({ decision: 'block', reason: 'no', systemMessage: 'said so' }) },
			{ action: 'skip', reason: 'no', notice: 'said so' },
		],
	])('%s', (_name, outcome, expected) => {
		expect(run(outcome)).toEqual(expected)
	})

	it('sets an unreadable answer aside with a warning, and the command runs', () => {
		expect(run({ ...ok, stdout: '{"decision":' })).toMatchObject({
			action: 'continue',
			notice: expect.stringContaining('not valid JSON'),
		})
	})

	it('sets aside a permission word it does not know, with a warning, and the command runs', () => {
		expect(run(specific({ permissionDecision: 'maybe' }))).toMatchObject({ action: 'continue' })
	})
})

describe('failures of the hook itself', () => {
	it('a hook that could not start refuses the command: nothing says it is safe', () => {
		expect(run({ ...ok, exitCode: null, spawnError: 'ENOENT' })).toEqual({
			action: 'skip',
			reason: "the hook couldn't run (ENOENT)",
		})
	})

	it('a hook that ran out of time warns and lets the command run', () => {
		expect(run({ ...ok, exitCode: null, timedOut: true })).toMatchObject({
			action: 'continue',
			notice: expect.stringContaining('timed out'),
		})
	})

	it('an entry that asks for failures to block refuses on every kind of failure', () => {
		const strict = { command: 'x', onFailure: 'block' }
		for (const outcome of [
			{ ...ok, exitCode: null, timedOut: true },
			{ ...ok, exitCode: 1, stderr: 'boom' },
			{ ...ok, stdout: '{"decision":' },
			{ ...ok, exitCode: null, spawnError: 'ENOENT' },
		]) {
			expect(run(outcome, strict)).toMatchObject({ action: 'skip' })
		}
	})
})

describe('the hooks that may answer', () => {
	const context = (toolName = 'bash'): PluginHookContext =>
		({
			event: 'pre_skill_shell_command',
			sessionId: asSessionId(SESSION),
			pluginId: 'p',
			toolName,
			toolInput: { command: 'ls' },
			toolCallId: 'skillshell_1',
			skillShell: { commandName: 'review', invokedBy: 'model' },
			signal: new AbortController().signal,
		}) as unknown as PluginHookContext
	const handlerOf = (hook: ReturnType<typeof createShellHook>) =>
		(hook as unknown as { handler: (c: PluginHookContext) => Promise<PluginHookResult> }).handler

	it.each([
		['prompt', { type: 'prompt', prompt: 'is this fine?' }],
		['http', { type: 'http', url: 'https://example.invalid/hook' }],
	])('refuses to ask a %s hook', async (kind, handler) => {
		const hook = createShellHook('pre_skill_shell_command', handler as never, {
			cwd: process.cwd(),
		})
		const answer = await handlerOf(hook)(context())
		expect(answer).toMatchObject({ action: 'skip' })
		expect((answer as { reason: string }).reason).toContain(`${kind} hooks don't run`)
	})

	it('matches on the shell tool name, in either spelling', async () => {
		const miss = createShellHook(
			'pre_skill_shell_command',
			{ command: 'exit 2', matcher: 'edit' } as never,
			{ cwd: process.cwd() },
		)
		expect(await handlerOf(miss)(context())).toEqual({ action: 'continue' })
		for (const matcher of ['bash', 'Bash', 'Bash|Edit']) {
			const hit = createShellHook(
				'pre_skill_shell_command',
				{ command: 'echo stop >&2; exit 2', matcher } as never,
				{ cwd: process.cwd() },
			)
			expect(await handlerOf(hit)(context())).toEqual({ action: 'skip', reason: 'stop' })
		}
	})

	it('is not asked for a command its `if` filter does not cover', async () => {
		const hook = createShellHook(
			'pre_skill_shell_command',
			{ command: 'exit 2', if: 'bash(git *)' } as never,
			{ cwd: process.cwd() },
		)
		expect(await handlerOf(hook)(context())).toEqual({ action: 'continue' })
	})

	it('reads the command back from stdin', async () => {
		const hook = createShellHook(
			'pre_skill_shell_command',
			{
				command: `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stderr.write(j.command_name+':'+j.invoked_by+':'+j.tool_input.command);process.exit(2)})"`,
			} as never,
			{ cwd: process.cwd() },
		)
		expect(await handlerOf(hook)(context())).toEqual({
			action: 'skip',
			reason: 'review:model:ls',
		})
	})
})

describe('what the hooks answered, as one verdict', () => {
	const cont = (more: object = {}): PluginHookResult => ({ action: 'continue', ...more }) as never
	const table: [string, PluginHookResult[], number, object][] = [
		['every hook let it run', [cont(), cont()], 2, { kind: 'run' }],
		[
			'one hook refused',
			[cont(), { action: 'skip', reason: 'no' }],
			2,
			{ kind: 'refuse', reason: 'no' },
		],
		[
			'two refusals are both told',
			[
				{ action: 'skip', reason: 'a' },
				{ action: 'skip', reason: 'b' },
			],
			2,
			{ kind: 'refuse', reason: 'a; b' },
		],
		[
			'a stop outranks a refusal',
			[{ action: 'skip', reason: 'no' }, cont({ halt: { reason: 'enough' } })],
			2,
			{ kind: 'stop', reason: 'enough' },
		],
		[
			'a warning rides with a run',
			[cont({ notice: 'careful' })],
			1,
			{ kind: 'run', warning: 'careful' },
		],
		[
			'an in-process ask is a refusal',
			[cont({ permission: { decision: 'ask' } })],
			1,
			{ kind: 'refuse', reason: "the hook asked for approval, which a skill can't wait for" },
		],
		[
			'an in-process rewrite is a refusal',
			[{ action: 'modify', input: { command: 'ls' } }],
			1,
			{ kind: 'refuse', reason: "the hook changed the command, which isn't supported here" },
		],
		[
			'a crash is a refusal',
			[{ action: 'error', message: 'boom' }],
			1,
			{ kind: 'refuse', reason: "the hook couldn't run" },
		],
		[
			'no answer at all, with a hook attached, is a refusal',
			[],
			1,
			{ kind: 'refuse', reason: "the hook didn't answer" },
		],
		[
			'a deadline passed warns and runs',
			[{ action: 'error', message: 'Hook timeout' }],
			1,
			{ kind: 'run', warning: 'a hook timed out, so the command ran without its answer' },
		],
	]
	it.each(table)('%s', (_name, results, attached, expected) => {
		expect(skillShellHookVerdict(results, attached)).toEqual(expected)
	})
})

describe('asking the hooks', () => {
	const noop = { executeHooks: vi.fn(), listHooks: () => [] }
	afterEach(() => vi.useRealTimers())

	it('asks nobody when none is attached for the event', () => {
		expect(
			createSkillShellHook({
				manager: noop as never,
				sessionId: SESSION,
				info: { commandName: 's', invokedBy: 'user' },
			}),
		).toBeUndefined()
		expect(
			createSkillShellHook({
				manager: undefined,
				sessionId: SESSION,
				info: { commandName: 's', invokedBy: 'user' },
			}),
		).toBeUndefined()
		expect(noop.executeHooks).not.toHaveBeenCalled()
	})

	it('tells the hook the command, its tool, its id and its source', async () => {
		const executeHooks = vi.fn(async () => [{ action: 'continue' } as PluginHookResult])
		const ask = createSkillShellHook({
			manager: {
				executeHooks,
				listHooks: () => [{ pluginId: 'p' as PluginId, event: 'pre_skill_shell_command' }],
			} as never,
			sessionId: SESSION,
			turnId: 't-1',
			info: { commandName: 'review', commandSource: 'plugin', invokedBy: 'other' },
		})
		expect(await ask?.('ls -la', 'skillshell_9')).toEqual({ kind: 'run' })
		expect(executeHooks).toHaveBeenCalledWith(
			'pre_skill_shell_command',
			expect.objectContaining({
				sessionId: SESSION,
				turnId: 't-1',
				toolName: 'bash',
				toolInput: { command: 'ls -la' },
				toolCallId: 'skillshell_9',
				skillShell: { commandName: 'review', commandSource: 'plugin', invokedBy: 'other' },
			}),
		)
	})

	it('refuses the command when asking the hooks throws', async () => {
		const ask = createSkillShellHook({
			manager: {
				executeHooks: async () => {
					throw new Error('manager gone')
				},
				listHooks: () => [{ pluginId: 'p' as PluginId, event: 'pre_skill_shell_command' }],
			} as never,
			sessionId: SESSION,
			info: { commandName: 's', invokedBy: 'user' },
		})
		expect(await ask?.('ls', 'id')).toEqual({ kind: 'refuse', reason: "the hook couldn't run" })
	})

	it('warns and lets the command run when a hook outlasts the manager’s deadline', async () => {
		vi.useFakeTimers()
		const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
		const manager = new PluginLifecycleManager({
			pluginRegistry: {} as never,
			scopeRoots: { project: process.cwd(), user: process.cwd() },
			log: log as never,
			hookTimeoutMs: 1_000,
		})
		manager.registerHook('p_slow' as PluginId, {
			event: 'pre_skill_shell_command',
			handler: () => new Promise<never>(() => undefined),
		})
		const ask = createSkillShellHook({
			manager,
			sessionId: SESSION as SessionId,
			info: { commandName: 's', invokedBy: 'user' },
		})
		const pending = ask?.('ls', 'id')
		await vi.advanceTimersByTimeAsync(1_000)
		expect(await pending).toEqual({
			kind: 'run',
			warning: 'a hook timed out, so the command ran without its answer',
		})
	})
})
