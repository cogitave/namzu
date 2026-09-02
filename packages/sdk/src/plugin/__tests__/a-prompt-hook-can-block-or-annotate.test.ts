import { describe, expect, it } from 'vitest'

import { applyLifecycleHookResults } from '../../runtime/query/plugin-hooks.js'
import { SHELL_HOOK_EVENTS, shellHookVerdict } from '../shell-hook.js'

const entry = { command: 'echo hi' }
const ok = (stdout: string) => ({ exitCode: 0, timedOut: false, stdout, stderr: '' })
const blocked = (stderr: string) => ({ exitCode: 2, timedOut: false, stdout: '', stderr })

describe('a shell hook on the prompt', () => {
	it('turns what it printed into context for the model', () => {
		expect(shellHookVerdict('user_prompt_submit', entry, ok('branch: main\n'))).toEqual({
			action: 'annotate',
			text: 'branch: main',
		})
	})

	it('says nothing when it printed nothing', () => {
		expect(shellHookVerdict('user_prompt_submit', entry, ok('  \n'))).toEqual({
			action: 'continue',
		})
	})

	it('blocks the prompt with exit 2', () => {
		expect(shellHookVerdict('user_prompt_submit', entry, blocked('not on main'))).toEqual({
			action: 'skip',
			reason: 'not on main',
		})
	})

	it('prints to the operator, not the model, on every other event', () => {
		expect(shellHookVerdict('run_start', entry, ok('noise'))).toEqual({ action: 'continue' })
		expect(shellHookVerdict('session_start', entry, blocked('no'))).toEqual({ action: 'continue' })
	})

	it('has the events an operator scripts against', () => {
		expect(SHELL_HOOK_EVENTS).toEqual([
			'user_prompt_submit',
			'session_start',
			'session_end',
			'pre_tool_use',
			'post_tool_use',
			'pre_compact',
			'post_compact',
			'subagent_stop',
			'run_start',
			'run_end',
		])
	})
})

describe('applying lifecycle results', () => {
	it('collects annotations on the prompt event', () => {
		expect(
			applyLifecycleHookResults('user_prompt_submit', [
				{ action: 'annotate', text: ' a ' },
				{ action: 'continue' },
				{ action: 'annotate', text: 'b' },
			]),
		).toEqual(['a', 'b'])
	})

	it('refuses an annotation anywhere else', () => {
		expect(() =>
			applyLifecycleHookResults('run_start', [{ action: 'annotate', text: 'a' }]),
		).toThrow(/only user_prompt_submit/)
	})

	it('turns a skip on the prompt into a blocked run, and rejects it elsewhere', () => {
		expect(() =>
			applyLifecycleHookResults('user_prompt_submit', [{ action: 'skip', reason: 'no' }]),
		).toThrow(/Prompt blocked by hook: no/)
		expect(() => applyLifecycleHookResults('run_end', [{ action: 'skip', reason: 'no' }])).toThrow(
			/unsupported action 'skip'/,
		)
	})
})
