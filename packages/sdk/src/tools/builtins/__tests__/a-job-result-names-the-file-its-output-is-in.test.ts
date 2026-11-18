import { describe, expect, it, vi } from 'vitest'

import type { ToolContext } from '../../../types/tool/index.js'
import { BashTool } from '../bash.js'
import { JobTool } from '../job.js'
import { WaitForJobTool } from '../wait-for-job.js'

/**
 * The model is told where a background job's output is saved when the job
 * starts and in every read and wait result, so it has no reason to redirect
 * the output into a file of its own.
 */

const FILE = '/tmp/namzu-1000/-work/abc/scratchpad/jobs/b00000001.log'

function context(outputFile: string | undefined): ToolContext {
	return {
		workingDirectory: process.cwd(),
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		backgroundJobs: {
			start: vi.fn(() => ({
				id: 'b00000001',
				status: 'running',
				...(outputFile ? { outputFile } : {}),
			})),
			get: () => ({ id: 'b00000001', status: 'exited', ...(outputFile ? { outputFile } : {}) }),
			read: () => ({
				chunk: 'tail',
				nextOffset: 4,
				droppedBytes: 0,
				status: 'exited',
				exitCode: 0,
			}),
			waitForExit: async () => ({
				kind: 'exited',
				status: 'exited',
				exitCode: 0,
				output: 'tail',
				nextOffset: 4,
				droppedBytes: 0,
				omittedOutputBytes: 0,
			}),
			list: () => [],
			kill: vi.fn(),
		},
	} as unknown as ToolContext
}

describe('a background job names its output file', () => {
	it('bash says where the output is saved and not to redirect it', async () => {
		const result = await BashTool.execute(
			{ command: 'pnpm test', timeout: 1_000, run_in_background: true },
			context(FILE),
		)
		expect(result.success).toBe(true)
		expect(result.output).toContain(`saved to ${FILE}`)
		expect(result.output).toContain('do not redirect it into a file of your own')
		expect(result.output).toContain('Use wait_for_job to wait for it to finish')
		expect(result.data).toMatchObject({ jobId: 'b00000001', outputFile: FILE })
	})

	it('bash says nothing about a file when the host keeps none', async () => {
		const result = await BashTool.execute(
			{ command: 'pnpm test', timeout: 1_000, run_in_background: true },
			context(undefined),
		)
		expect(result.output).toBe('Started background job b00000001; state: running.')
	})

	it('job read repeats the path', async () => {
		const result = await JobTool.execute({ action: 'read', id: 'b00000001' }, context(FILE))
		expect(result.output).toContain(`the whole output is in ${FILE}`)
	})

	it('wait_for_job repeats the path', async () => {
		const result = await WaitForJobTool.execute({ id: 'b00000001' } as never, context(FILE))
		expect(result.output).toContain(`the whole output is in ${FILE}`)
	})

	it('the bash description tells the model long and background output is saved for it', () => {
		expect(BashTool.description).toContain('are saved to a file whose path you are given')
		expect(BashTool.description).toContain('do not redirect output into files of your own')
	})
})
