/**
 * A shell hook's exit code is its answer, and only `2` before a tool means no.
 *
 * Real `sh`, not a stub: the contract is about what a process the operator
 * wrote can say back, and a fake process proves only that the mapper agrees
 * with itself. The attach test drives a definition exactly the way the
 * lifecycle manager would — through its `handler` with a hook context — so
 * the matcher, the spawn and the verdict are covered as one hop.
 */

import { describe, expect, it, vi } from 'vitest'

import type { PluginHookContext, PluginHookDefinition } from '../../types/plugin/index.js'
import { asSessionId, asTurnId } from '../../utils/id.js'
import {
	SHELL_HOOKS_PLUGIN_ID,
	attachShellHooks,
	runShellHook,
	shellHookMatches,
	shellHookVerdict,
} from '../shell-hook.js'

const CWD = process.cwd()
const SESSION = '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b'
const TURN = 'f9ad17f0-01b6-4905-810a-3ef3324a614d'
const base = { cwd: CWD, sessionId: SESSION, turnId: TURN } as const

describe('shellHookMatches', () => {
	it('matches everything when there is no matcher, and nothing named when there is no tool', () => {
		expect(shellHookMatches(undefined, 'bash')).toBe(true)
		expect(shellHookMatches('*', 'bash')).toBe(true)
		expect(shellHookMatches('bash', undefined)).toBe(false)
		expect(shellHookMatches(undefined, undefined)).toBe(true)
	})

	it('takes a name, a list, or a prefix', () => {
		expect(shellHookMatches('bash', 'bash')).toBe(true)
		expect(shellHookMatches('bash', 'Bash')).toBe(false)
		expect(shellHookMatches('edit|write', 'write')).toBe(true)
		expect(shellHookMatches('edit|write', 'read')).toBe(false)
		expect(shellHookMatches('mcp_*', 'mcp_tickets_create')).toBe(true)
		expect(shellHookMatches('mcp_*', 'read')).toBe(false)
	})
})

describe('runShellHook', () => {
	it('hands the event to the command on stdin and in the environment', async () => {
		const outcome = await runShellHook(
			{
				command:
					'cat; printf " env=%s/%s/%s" "$NAMZU_HOOK_EVENT" "$NAMZU_TOOL_NAME" "$NAMZU_TOOL_PATH"',
			},
			{
				...base,
				event: 'pre_tool_use',
				toolName: 'edit',
				toolInput: { path: 'src/a.ts', old_string: 'x' },
			},
		)
		expect(outcome.exitCode).toBe(0)
		const json = JSON.parse(outcome.stdout.slice(0, outcome.stdout.indexOf(' env=')))
		expect(json).toMatchObject({
			event: 'pre_tool_use',
			session_id: SESSION,
			turn_id: TURN,
			tool_name: 'edit',
			tool_input: { path: 'src/a.ts', old_string: 'x' },
		})
		expect(outcome.stdout).toContain('env=pre_tool_use/edit/src/a.ts')
	})

	it('gives a turn hook the session and the turn, on stdin and in the environment', async () => {
		const outcome = await runShellHook(
			{ command: 'cat; printf " env=%s/%s" "$NAMZU_SESSION_ID" "$NAMZU_TURN_ID"' },
			{ ...base, event: 'turn_start' },
		)
		expect(outcome.exitCode).toBe(0)
		const json = JSON.parse(outcome.stdout.slice(0, outcome.stdout.indexOf(' env=')))
		expect(json).toEqual({ event: 'turn_start', cwd: CWD, session_id: SESSION, turn_id: TURN })
		expect(outcome.stdout).toContain(`env=${SESSION}/${TURN}`)
	})

	it.each(['session_start', 'session_end'] as const)(
		'gives %s the session and no turn, not even one inherited from the host environment',
		async (event) => {
			const inherited = process.env.NAMZU_TURN_ID
			process.env.NAMZU_TURN_ID = 'leaked-from-an-enclosing-hook'
			try {
				const outcome = await runShellHook(
					{
						command: 'cat; printf " env=%s/%s" "$NAMZU_SESSION_ID" "${NAMZU_TURN_ID-unset}"',
					},
					{ cwd: CWD, sessionId: SESSION, event },
				)
				expect(outcome.exitCode).toBe(0)
				const json = JSON.parse(outcome.stdout.slice(0, outcome.stdout.indexOf(' env=')))
				expect(json).toEqual({ event, cwd: CWD, session_id: SESSION })
				expect(outcome.stdout).toContain(`env=${SESSION}/unset`)
			} finally {
				if (inherited === undefined) Reflect.deleteProperty(process.env, 'NAMZU_TURN_ID')
				else process.env.NAMZU_TURN_ID = inherited
			}
		},
	)

	it('tells subagent_stop which session and turn delegated', async () => {
		const outcome = await runShellHook(
			{ command: 'cat' },
			{
				...base,
				event: 'subagent_stop',
				parentSessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a00',
				parentTurnId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a01',
			},
		)
		const json = JSON.parse(outcome.stdout)
		expect(json).toEqual({
			event: 'subagent_stop',
			cwd: CWD,
			session_id: SESSION,
			turn_id: TURN,
			parent_session_id: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a00',
			parent_turn_id: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a01',
		})
	})

	it('captures the exit code and stderr', async () => {
		const outcome = await runShellHook(
			{ command: 'echo "not on my watch" >&2; exit 2' },
			{ ...base, event: 'pre_tool_use', toolName: 'bash' },
		)
		expect(outcome.exitCode).toBe(2)
		expect(outcome.stderr.trim()).toBe('not on my watch')
		expect(outcome.timedOut).toBe(false)
	})

	it('kills a hook that outlives its deadline and says so', async () => {
		const outcome = await runShellHook(
			{ command: 'sleep 5', timeoutMs: 150 },
			{ ...base, event: 'turn_end' },
		)
		expect(outcome.timedOut).toBe(true)
	})
})

describe('shellHookVerdict', () => {
	const entry = { command: 'x' }
	const ok = { exitCode: 0, timedOut: false, stdout: '', stderr: '' }

	it('kills what the hook started, not only the shell, so a survivor cannot hold the outcome', async () => {
		// `sleep 5 &` is a grandchild holding stdout. Killing only the shell
		// would leave the pipe open and this would take five seconds.
		const startedAt = Date.now()
		const outcome = await runShellHook(
			{ command: 'sleep 5 & wait', timeoutMs: 150 },
			{ ...base, event: 'turn_start' },
		)
		expect(outcome.timedOut).toBe(true)
		expect(Date.now() - startedAt).toBeLessThan(3000)
	})

	it('carries on for 0', () => {
		expect(shellHookVerdict('pre_tool_use', entry, ok)).toEqual({ action: 'continue' })
	})

	it('blocks a tool call on 2, with stderr as the reason the model reads', () => {
		expect(
			shellHookVerdict('pre_tool_use', entry, { ...ok, exitCode: 2, stderr: 'no pushes today\n' }),
		).toEqual({ action: 'skip', reason: 'no pushes today' })
		expect(shellHookVerdict('pre_tool_use', entry, { ...ok, exitCode: 2 })).toEqual({
			action: 'skip',
			reason: 'blocked by hook `x`',
		})
	})

	it('cannot block after the fact: 2 on a post or turn event carries on, and is logged', () => {
		const warn = vi.fn()
		const log = { warn } as unknown as Parameters<typeof shellHookVerdict>[3]
		expect(shellHookVerdict('post_tool_use', entry, { ...ok, exitCode: 2 }, log)).toEqual({
			action: 'continue',
		})
		expect(shellHookVerdict('turn_end', entry, { ...ok, exitCode: 2 }, log)).toEqual({
			action: 'continue',
		})
		expect(warn).toHaveBeenCalledTimes(2)
	})

	it("treats any other failure as the hook's own, never as a verdict", () => {
		const warn = vi.fn()
		const log = { warn } as unknown as Parameters<typeof shellHookVerdict>[3]
		expect(shellHookVerdict('pre_tool_use', entry, { ...ok, exitCode: 127 }, log)).toEqual({
			action: 'continue',
		})
		expect(
			shellHookVerdict('pre_tool_use', entry, { ...ok, timedOut: true, exitCode: null }, log),
		).toEqual({ action: 'continue' })
		expect(
			shellHookVerdict('pre_tool_use', entry, { ...ok, exitCode: null, spawnError: 'ENOENT' }, log),
		).toEqual({ action: 'continue' })
		expect(warn).toHaveBeenCalledTimes(3)
	})
})

describe('attachShellHooks', () => {
	it('registers one definition per entry under the shell-hooks id, and each decides like the manager would ask it to', async () => {
		const registered: Array<{ pluginId: string; hook: PluginHookDefinition }> = []
		const manager = {
			registerHook: (pluginId: string, hook: PluginHookDefinition) => {
				registered.push({ pluginId, hook })
			},
		}

		const count = attachShellHooks(
			manager as never,
			{
				pre_tool_use: [{ matcher: 'bash', command: 'echo "no shell for you" >&2; exit 2' }],
				turn_end: [{ command: 'exit 0' }],
			},
			{ cwd: CWD },
		)

		expect(count).toBe(2)
		expect(registered.map((r) => [r.pluginId, r.hook.event])).toEqual([
			[SHELL_HOOKS_PLUGIN_ID, 'pre_tool_use'],
			[SHELL_HOOKS_PLUGIN_ID, 'turn_end'],
		])

		const pre = registered[0]?.hook
		if (!pre) throw new Error('no pre hook')
		const context = (toolName: string): PluginHookContext =>
			({
				sessionId: asSessionId(SESSION),
				turnId: asTurnId('23ebee71-76bb-4e8e-b30f-e5183b1eba11'),
				pluginId: SHELL_HOOKS_PLUGIN_ID,
				event: 'pre_tool_use',
				toolName,
				toolInput: { command: 'rm -rf /' },
			}) as PluginHookContext
		expect(await pre.handler(context('bash'))).toEqual({
			action: 'skip',
			reason: 'no shell for you',
		})
		expect(await pre.handler(context('read')), 'the matcher keeps it off other tools').toEqual({
			action: 'continue',
		})
	})

	it.each([
		['run_start', 'turn_start'],
		['run_end', 'turn_end'],
		['run_interrupt', 'turn_interrupt'],
	])('refuses a config naming %s, and names %s, before registering anything', (old, renamed) => {
		const registerHook = vi.fn()
		expect(() =>
			attachShellHooks(
				{ registerHook },
				{ pre_tool_use: [{ command: 'exit 0' }], [old]: [{ command: 'exit 0' }] } as never,
				{ cwd: CWD },
			),
		).toThrow(new RegExp(`'${old}' was renamed to '${renamed}'`))
		expect(registerHook).not.toHaveBeenCalled()
	})
})
