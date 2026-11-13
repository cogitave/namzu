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
			[
				'pre_tool_use',
				'  lint.sh · matches write|edit · 5s · tool names Namzu’s own (bash)',
				'session_start',
				'  echo hi',
			].join('\n'),
		)
	})

	it('says under a hook that its matcher or if cannot be read, and what that means', () => {
		const text = renderHooks({
			pre_tool_use: [{ command: 'guard.sh', matcher: '(unclosed', if: '^Edit$' }],
		})
		expect(text).toContain('cannot be read: the matcher "(unclosed"')
		expect(text).toContain('fires for every call')
		expect(text).toContain('cannot be read: the if "^Edit$"')
		expect(renderHooks({ pre_tool_use: [{ command: 'a', matcher: 'Edit|Write' }] })).not.toContain(
			'cannot be read',
		)
	})

	it('shows a hook’s filter and that it runs once', () => {
		expect(
			renderHooks({
				pre_tool_use: [{ command: 'guard.sh', if: 'Bash(git push *)', once: true }],
			}),
		).toBe(
			[
				'pre_tool_use',
				'  guard.sh · if Bash(git push *) · once · tool names Namzu’s own (bash)',
			].join('\n'),
		)
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
				'  POST https://hooks.example.test/x · blocks when it fails · tool names Namzu’s own (bash)',
				'  ask: Is this safe?',
				'  log.sh · in background · tool names Namzu’s own (bash)',
			].join('\n'),
		)
	})
})
