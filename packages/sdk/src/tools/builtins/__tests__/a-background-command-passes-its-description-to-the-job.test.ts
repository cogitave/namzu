import { describe, expect, it, vi } from 'vitest'

import type { ToolContext } from '../../../types/tool/index.js'
import { BashTool } from '../bash.js'

/**
 * The model's own short label for a command (its `description`) goes to the job,
 * so a host can name the job by what it is for.
 */

function context(start: ReturnType<typeof vi.fn>): ToolContext {
	return {
		workingDirectory: process.cwd(),
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		backgroundJobs: { start, get: () => ({ id: 'b1', status: 'running' }), list: () => [] },
	} as unknown as ToolContext
}

describe('a background bash command with a description', () => {
	it('hands the description to the job, on one line', async () => {
		const start = vi.fn((_params: Record<string, unknown>) => ({ id: 'b1', status: 'running' }))
		await BashTool.execute(
			{
				command: 'npm test',
				timeout: 1_000,
				run_in_background: true,
				description: '  Run full\n test suite  ',
			},
			context(start),
		)
		expect(start).toHaveBeenCalledWith(
			expect.objectContaining({ command: 'npm test', description: 'Run full test suite' }),
		)
	})

	it('hands over none when the call has none', async () => {
		const start = vi.fn((_params: Record<string, unknown>) => ({ id: 'b1', status: 'running' }))
		await BashTool.execute(
			{ command: 'npm test', timeout: 1_000, run_in_background: true },
			context(start),
		)
		expect(start.mock.calls[0]?.[0]).not.toHaveProperty('description')
	})
})
