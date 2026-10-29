import { describe, expect, it } from 'vitest'

import { renderHooks } from '../slashCommands.js'

describe('/hooks', () => {
	it('says how to add one when there are none', () => {
		expect(renderHooks(undefined)).toContain('No hooks')
		expect(renderHooks({ pre_tool_use: [] })).toContain('No hooks')
	})

	it('lists every hook under its event with its matcher and deadline', () => {
		expect(
			renderHooks({
				pre_tool_use: [{ command: 'lint.sh', matcher: 'write|edit', timeoutMs: 5_000 }],
				session_start: [{ command: 'echo hi' }],
			}),
		).toBe(
			['pre_tool_use', '  lint.sh · matches write|edit · 5s', 'session_start', '  echo hi'].join(
				'\n',
			),
		)
	})

	it('shows a hook’s filter and that it runs once', () => {
		expect(
			renderHooks({
				pre_tool_use: [{ command: 'guard.sh', if: 'Bash(git push *)', once: true }],
			}),
		).toBe(['pre_tool_use', '  guard.sh · if Bash(git push *) · once'].join('\n'))
	})

	it('names an http hook by its address, a prompt hook by its question, and what each does on failure', () => {
		expect(
			renderHooks({
				pre_tool_use: [
					{ type: 'http', url: 'https://hooks.example.test/x', onFailure: 'block' },
					{ type: 'prompt', prompt: 'Is  this\nsafe?' },
					{ command: 'log.sh', async: true },
				],
			}),
		).toBe(
			[
				'pre_tool_use',
				'  POST https://hooks.example.test/x · blocks when it fails',
				'  ask: Is this safe?',
				'  log.sh · in background',
			].join('\n'),
		)
	})
})
