/**
 * `worktree_create` and `worktree_remove` as shell hooks: what they are sent,
 * how their answer is read (a path, or a failure that names the hook and what
 * it printed), and that a filter or a one-shot flag cannot make them skip.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { PluginHookContext, PluginHookResult } from '../../types/plugin/index.js'
import { asSessionId } from '../../utils/id.js'
import {
	SHELL_HOOK_EVENTS,
	SHELL_HOOK_PASCAL_EVENT_NAMES,
	createShellHook,
	shellHookPayload,
} from '../shell-hook.js'
import { worktreeHookPrinted, worktreeHookVerdict } from '../worktree-hook-answer.js'

const SESSION = '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b'
const ok = { exitCode: 0, timedOut: false, stdout: '', stderr: '' }
const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), 'wt-hook-'))
	dirs.push(dir)
	return dir
}

describe('the events', () => {
	it('are shell hook events with their written names', () => {
		expect(SHELL_HOOK_EVENTS).toContain('worktree_create')
		expect(SHELL_HOOK_EVENTS).toContain('worktree_remove')
		expect(SHELL_HOOK_PASCAL_EVENT_NAMES.worktree_create).toBe('WorktreeCreate')
		expect(SHELL_HOOK_PASCAL_EVENT_NAMES.worktree_remove).toBe('WorktreeRemove')
	})

	it('send the name and where it is placed, and the path to remove', () => {
		const made = JSON.parse(
			shellHookPayload({
				event: 'worktree_create',
				cwd: '/p',
				sessionId: SESSION,
				worktreeName: 'feat-x',
				worktreeRoot: '/w',
				worktreeBaseRef: 'abc',
			}),
		)
		expect(made).toMatchObject({
			hook_event_name: 'WorktreeCreate',
			name: 'feat-x',
			worktree_root: '/w',
			base_ref: 'abc',
		})
		const gone = JSON.parse(
			shellHookPayload({
				event: 'worktree_remove',
				cwd: '/p',
				sessionId: SESSION,
				worktreePath: '/w/feat-x',
			}),
		)
		expect(gone).toMatchObject({ hook_event_name: 'WorktreeRemove', worktree_path: '/w/feat-x' })
		expect(gone.name).toBeUndefined()
	})
})

describe('the answer of a create hook', () => {
	it('is the last non-empty line it printed', () => {
		const verdict = worktreeHookVerdict('worktree_create', 'h', {
			...ok,
			stdout: 'copying...\ndone\n/w/x\n\n',
		})
		expect(verdict).toEqual({ action: 'continue', worktreePath: '/w/x' })
	})

	it('is hookSpecificOutput.worktreePath of a JSON answer', () => {
		const stdout = JSON.stringify({ hookSpecificOutput: { worktreePath: 'rel/x' } })
		expect(worktreeHookVerdict('worktree_create', 'h', { ...ok, stdout })).toEqual({
			action: 'continue',
			worktreePath: 'rel/x',
		})
	})

	it('fails, never falls back, when no path was given, naming the hook and what it printed', () => {
		const verdict = worktreeHookVerdict('worktree_create', 'make.sh', ok)
		expect(verdict).toMatchObject({ action: 'error' })
		expect((verdict as { message: string }).message).toContain('make.sh')
		expect((verdict as { message: string }).message).toContain('it printed nothing')
	})

	it('fails on a nonzero exit, a time-out, a start failure, a refusal and a path at the wrong level', () => {
		const failures = [
			{ ...ok, exitCode: 1, stdout: '/w/x', stderr: 'boom' },
			{ ...ok, exitCode: 2, stderr: 'no' },
			{ ...ok, exitCode: null, timedOut: true },
			{ ...ok, exitCode: null, spawnError: 'ENOENT' },
			{ ...ok, stdout: JSON.stringify({ decision: 'block', reason: 'not now' }) },
			{ ...ok, stdout: JSON.stringify({ continue: false, stopReason: 'stop' }) },
			{ ...ok, stdout: JSON.stringify({ worktreePath: '/w/x' }) },
			{ ...ok, stdout: JSON.stringify({ hookSpecificOutput: { worktreePath: 5 } }) },
			{ ...ok, stdout: JSON.stringify({ hookSpecificOutput: {} }) },
			{ ...ok, stdout: '/w/x', stdoutTruncated: true },
		]
		for (const outcome of failures) {
			const verdict = worktreeHookVerdict('worktree_create', 'h', outcome)
			expect(verdict.action).toBe('error')
		}
	})

	it('shows the start and the end of long output', () => {
		const text = `${'a'.repeat(400)}MIDDLE${'z'.repeat(400)}`
		const shown = worktreeHookPrinted({ stdout: text, stderr: '' })
		expect(shown).toContain('aaaa')
		expect(shown).toContain('zzzz')
		expect(shown).not.toContain('MIDDLE')
	})
})

describe('the answer of a remove hook', () => {
	it('is a clean finish, whatever it printed', () => {
		expect(worktreeHookVerdict('worktree_remove', 'h', { ...ok, stdout: 'removed' })).toEqual({
			action: 'continue',
		})
	})

	it('is a failure with the start and the end of what it printed', () => {
		const verdict = worktreeHookVerdict('worktree_remove', 'rm.sh', {
			...ok,
			exitCode: 3,
			stderr: `${'a'.repeat(500)}${'z'.repeat(500)}`,
		})
		expect(verdict.action).toBe('error')
		const message = (verdict as { message: string }).message
		expect(message).toContain('rm.sh')
		expect(message).toContain('exit 3')
		expect(message).toContain('aaaa')
		expect(message).toContain('zzzz')
	})
})

describe('a real hook process', () => {
	const context = (extra: Partial<PluginHookContext>): PluginHookContext =>
		({
			sessionId: asSessionId(SESSION),
			pluginId: 'p',
			event: 'worktree_create',
			...extra,
		}) as unknown as PluginHookContext

	// Starts a real shell: the default per-test timeout is enough, but the
	// work is a real subprocess and not a clock.
	it('makes a copy and answers its path; a relative answer is left for the host to place', async () => {
		const dir = scratch()
		const script = join(dir, 'make.sh')
		writeFileSync(
			script,
			'#!/bin/sh\ninput=$(cat)\nname=$(printf %s "$input" | sed -n \'s/.*"name":"\\([^"]*\\)".*/\\1/p\')\nmkdir -p "$1/$name"\necho progress\necho "$name"\n',
			{ mode: 0o755 },
		)
		const hook = createShellHook(
			'worktree_create',
			{ command: `${script} ${dir}`, if: 'Bash(never)', once: true },
			{ cwd: dir },
		)
		for (let round = 0; round < 2; round++) {
			const answer = (await hook.handler(
				context({ worktreeName: 'copy-1', worktreeRoot: dir }),
			)) as PluginHookResult
			// Neither `if` nor `once` can make a worktree hook skip.
			expect(answer).toEqual({ action: 'continue', worktreePath: 'copy-1' })
		}
	})

	it('fails with the hook named when its script fails', async () => {
		const dir = scratch()
		const hook = createShellHook(
			'worktree_create',
			{ command: 'echo no space left; exit 4' },
			{ cwd: dir },
		)
		const answer = (await hook.handler(context({ worktreeName: 'x' }))) as PluginHookResult
		expect(answer.action).toBe('error')
		expect((answer as { message: string }).message).toContain('no space left')
	})

	it('reports a prompt entry as a failure, not a skip', async () => {
		const hook = createShellHook(
			'worktree_remove',
			{ type: 'prompt', prompt: 'ok?' },
			{ cwd: scratch() },
		)
		const answer = (await hook.handler(
			context({ event: 'worktree_remove', worktreePath: '/x' }),
		)) as PluginHookResult
		expect(answer.action).toBe('error')
	})

	it('runs a remove hook that deletes the folder', async () => {
		const dir = scratch()
		const target = join(dir, 'gone')
		mkdirSync(target)
		const hook = createShellHook('worktree_remove', { command: `rm -rf ${target}` }, { cwd: dir })
		const answer = (await hook.handler(
			context({ event: 'worktree_remove', worktreePath: target }),
		)) as PluginHookResult
		expect(answer).toEqual({ action: 'continue' })
	})
})
