import { describe, expect, it } from 'vitest'

import { BackgroundJobRegistry } from '../registry.js'

/**
 * A command that backgrounds its real work exits the shell at once. The job
 * is the process group, so it stays running until the survivor ends, and
 * `kill` takes the survivor with it.
 */

const skip = process.platform === 'win32'

describe.skipIf(skip)('a job is its process group', () => {
	it('stays running after the shell exits while its child lives, then ends with the shell code', async () => {
		const registry = new BackgroundJobRegistry()
		const exits: string[] = []
		registry.onExit((job) => exits.push(`${job.id}:${job.status}:${job.exitCode}`))
		const job = registry.start({
			owner: 'o',
			command: 'sleep 0.6 & exit 7',
			workingDirectory: process.cwd(),
		})
		await new Promise((r) => setTimeout(r, 200))
		expect(registry.get(job.id).status).toBe('running')
		expect(exits).toEqual([])
		await new Promise((r) => setTimeout(r, 900))
		expect(registry.get(job.id).status).toBe('exited')
		expect(registry.get(job.id).exitCode).toBe(7)
		expect(exits).toEqual([`${job.id}:exited:7`])
	})

	it('kills the survivor with the job', async () => {
		const registry = new BackgroundJobRegistry()
		const job = registry.start({
			owner: 'o',
			command: 'sleep 30 & exit 0',
			workingDirectory: process.cwd(),
		})
		await new Promise((r) => setTimeout(r, 200))
		expect(registry.get(job.id).status).toBe('running')
		const startedAt = Date.now()
		const stopped = await registry.kill(job.id)
		expect(stopped.status).toBe('killed')
		expect(Date.now() - startedAt).toBeLessThan(5_000)
	})
})
