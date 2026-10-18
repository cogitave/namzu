import type { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'

import { isBackgroundJobId } from '../../../runtime/jobs/job-id.js'
import { BackgroundJobRegistry, bindOwner } from '../../../runtime/jobs/registry.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { JobTool } from '../job.js'
import { WaitForJobTool } from '../wait-for-job.js'

function fakeChild() {
	return Object.assign(new EventEmitter(), { pid: undefined as number | undefined })
}

function start(registry: BackgroundJobRegistry, owner = 'owner') {
	return registry.start({
		owner,
		command: 'sleep 1',
		workingDirectory: process.cwd(),
		spawn: () => ({ child: fakeChild() as ReturnType<typeof spawn> }),
	})
}

function contextFor(registry: BackgroundJobRegistry, owner = 'owner'): ToolContext {
	return { backgroundJobs: bindOwner(registry, owner) } as unknown as ToolContext
}

describe('background job ids from a real registry', () => {
	it('are typed, never restart, and differ between registries and within one', () => {
		const first = new BackgroundJobRegistry()
		const second = new BackgroundJobRegistry()
		const ids = [start(first).id, start(first).id, start(second).id, start(second).id]
		for (const id of ids) expect(isBackgroundJobId(id)).toBe(true)
		expect(new Set(ids).size).toBe(4)
	})
})

describe('the job tools refuse only input that cannot be an id', () => {
	it.each(['a b', 'a\nb', 'x'.repeat(129)])('job read refuses %j before lookup', async (id) => {
		const registry = new BackgroundJobRegistry()
		start(registry)
		const result = await JobTool.execute({ action: 'read', id }, contextFor(registry))
		expect(result.success).toBe(false)
		expect(result.error).toContain('not a background job id')
	})

	it('wait_for_job refuses an id with whitespace before lookup', async () => {
		const registry = new BackgroundJobRegistry()
		const result = await WaitForJobTool.execute({ id: 'b1 2' }, contextFor(registry))
		expect(result.success).toBe(false)
		expect(result.error).toContain('not a background job id')
	})

	it.each(['job_1', 'bzzzzzzzz', 'host-id/7'])(
		'an unknown id (%s), whatever its shape, gets the registry answer',
		async (id) => {
			const registry = new BackgroundJobRegistry()
			const job = start(registry)
			const read = await JobTool.execute({ action: 'read', id }, contextFor(registry))
			expect(read.success).toBe(false)
			expect(read.error).toBe(`No background job ${id}.`)
			const kill = await JobTool.execute({ action: 'kill', id }, contextFor(registry))
			expect(kill.error).toBe(`No background job ${id}.`)
			const wait = await WaitForJobTool.execute({ id }, contextFor(registry))
			expect(wait.error).toBe(`No background job ${id}.`)
			expect(registry.get(job.id).status).toBe('running')
		},
	)
})
