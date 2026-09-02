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
import { asRunId } from '../../utils/id.js'
import {
	SHELL_HOOKS_PLUGIN_ID,
	attachShellHooks,
	runShellHook,
	shellHookMatches,
	shellHookVerdict,
} from '../shell-hook.js'

const CWD = process.cwd()
const base = { cwd: CWD, runId: 'run_hooks' } as const

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
			run_id: 'run_hooks',
			tool_name: 'edit',
			tool_input: { path: 'src/a.ts', old_string: 'x' },
		})
		expect(outcome.stdout).toContain('env=pre_tool_use/edit/src/a.ts')
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
			{ ...base, event: 'run_end' },
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
			{ event: 'run_start', cwd: process.cwd(), runId: 'run_test' },
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

	it('cannot block after the fact: 2 on a post or run event carries on, and is logged', () => {
		const warn = vi.fn()
		const log = { warn } as unknown as Parameters<typeof shellHookVerdict>[3]
		expect(shellHookVerdict('post_tool_use', entry, { ...ok, exitCode: 2 }, log)).toEqual({
			action: 'continue',
		})
		expect(shellHookVerdict('run_end', entry, { ...ok, exitCode: 2 }, log)).toEqual({
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
				run_end: [{ command: 'exit 0' }],
			},
			{ cwd: CWD },
		)

		expect(count).toBe(2)
		expect(registered.map((r) => [r.pluginId, r.hook.event])).toEqual([
			[SHELL_HOOKS_PLUGIN_ID, 'pre_tool_use'],
			[SHELL_HOOKS_PLUGIN_ID, 'run_end'],
		])

		const pre = registered[0]?.hook
		if (!pre) throw new Error('no pre hook')
		const context = (toolName: string): PluginHookContext =>
			({
				runId: asRunId('run_attach'),
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
})
