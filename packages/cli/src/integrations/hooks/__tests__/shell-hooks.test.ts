/**
 * A hook's exit code is its answer, and only `2` before a tool means no.
 *
 * Real `sh`, not a stub: the contract is about what a process the operator
 * wrote can say back, and a fake process proves only that the mapper agrees
 * with itself. Each case is one shell one-liner.
 */

import { describe, expect, it } from 'vitest'

import { hookMatches, hookVerdict, runShellHook } from '../shell-hooks.js'

const CWD = process.cwd()
const base = { cwd: CWD, runId: 'run_hooks' } as const

describe('hookMatches', () => {
	it('matches everything when there is no matcher, and nothing named when there is no tool', () => {
		expect(hookMatches(undefined, 'bash')).toBe(true)
		expect(hookMatches('*', 'bash')).toBe(true)
		expect(hookMatches('bash', undefined)).toBe(false)
		expect(hookMatches(undefined, undefined)).toBe(true)
	})

	it('takes a name, a list, or a prefix', () => {
		expect(hookMatches('bash', 'bash')).toBe(true)
		expect(hookMatches('bash', 'Bash')).toBe(false)
		expect(hookMatches('edit|write', 'write')).toBe(true)
		expect(hookMatches('edit|write', 'read')).toBe(false)
		expect(hookMatches('mcp_*', 'mcp_tickets_create')).toBe(true)
		expect(hookMatches('mcp_*', 'read')).toBe(false)
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

describe('hookVerdict', () => {
	const entry = { command: 'x' }
	const ok = { exitCode: 0, timedOut: false, stdout: '', stderr: '' }

	it('carries on for 0', () => {
		expect(hookVerdict('pre_tool_use', entry, ok)).toEqual({ action: 'continue' })
	})

	it('blocks a tool call on 2, with stderr as the reason the model reads', () => {
		expect(
			hookVerdict('pre_tool_use', entry, { ...ok, exitCode: 2, stderr: 'no pushes today\n' }),
		).toEqual({ action: 'skip', reason: 'no pushes today' })
		expect(hookVerdict('pre_tool_use', entry, { ...ok, exitCode: 2 })).toEqual({
			action: 'skip',
			reason: 'blocked by hook `x`',
		})
	})

	it('cannot block after the fact: 2 on a post or run event carries on', () => {
		expect(hookVerdict('post_tool_use', entry, { ...ok, exitCode: 2 })).toEqual({
			action: 'continue',
		})
		expect(hookVerdict('run_end', entry, { ...ok, exitCode: 2 })).toEqual({ action: 'continue' })
	})

	it("treats any other failure as the hook's own, never as a verdict", () => {
		expect(hookVerdict('pre_tool_use', entry, { ...ok, exitCode: 127 })).toEqual({
			action: 'continue',
		})
		expect(hookVerdict('pre_tool_use', entry, { ...ok, timedOut: true, exitCode: null })).toEqual({
			action: 'continue',
		})
		expect(
			hookVerdict('pre_tool_use', entry, { ...ok, exitCode: null, spawnError: 'ENOENT' }),
		).toEqual({ action: 'continue' })
	})
})
