import { afterEach, describe, expect, it } from 'vitest'

import { execHostShell } from '../../../tools/builtins/bash.js'
import { JobTool } from '../../../tools/builtins/job.js'
import { type CommandShell, setHostCommandShellForTesting } from '../../../tools/command-shell.js'
import { BackgroundJobRegistry, bindOwner } from '../registry.js'

const MISSING: CommandShell = {
	path: '/nonexistent/namzu-test-shell',
	dialect: 'sh',
	source: 'override',
}

afterEach(() => setHostCommandShellForTesting(undefined))

describe('a background job whose shell cannot be started', () => {
	it('ends with a readable reason, in the record and in the output', async () => {
		setHostCommandShellForTesting(MISSING)
		const registry = new BackgroundJobRegistry()
		const job = registry.start({ owner: 'o', command: 'echo hi', workingDirectory: process.cwd() })
		const started = await registry.awaitStarted(job.id)
		expect(started.error).toMatch(/^Could not start the command: .*ENOENT/)
		const ended = await registry.waitForExit(job.id)
		expect(ended.status).toBe('exited')
		expect(ended.exitCode).toBeUndefined()
		expect(ended.error).toBe(started.error)
		const read = registry.read(job.id, {})
		expect(read.chunk).toContain('Could not start the command')
		expect(read.error).toBe(started.error)
	})

	it('is reported by the job tool as failed to start, not as a plain exit', async () => {
		setHostCommandShellForTesting(MISSING)
		const registry = new BackgroundJobRegistry()
		const jobs = bindOwner(registry, 'o', { workingDirectory: process.cwd() })
		const job = jobs.start({ command: 'echo hi' })
		await jobs.waitForExit(job.id)
		const result = await JobTool.execute({ action: 'read', id: job.id }, {
			backgroundJobs: jobs,
		} as never)
		expect(result.output).toContain('failed to start: Could not start the command')
		expect(result.data).toMatchObject({ error: expect.stringContaining('Could not start') })
	})
})

describe('a foreground command whose shell cannot be started', () => {
	it('rejects with the same words', async () => {
		await expect(
			execHostShell('echo hi', {
				cwd: process.cwd(),
				env: process.env,
				timeout: 60_000,
				maxBuffer: 1024,
				shell: MISSING,
			}),
		).rejects.toMatchObject({
			code: 'ENOENT',
			message: expect.stringMatching(/^Could not start the command: /),
		})
	})
})
