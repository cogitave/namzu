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
})
