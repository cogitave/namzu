import type { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'

import { BackgroundJobRegistry } from '../registry.js'

function child(): EventEmitter & { pid: number | undefined } {
	return Object.assign(new EventEmitter(), {
		pid: undefined as number | undefined,
	})
}

function startWith(
	registry: BackgroundJobRegistry,
	fakeChild: EventEmitter & { pid: number | undefined },
) {
	return registry.start({
		owner: 'test-owner',
		command: 'synthetic child',
		workingDirectory: process.cwd(),
		spawn: () => ({ child: fakeChild as ReturnType<typeof spawn> }),
	})
}

describe('one exit announcement per background job', () => {
	it('waits for close after a failed spawn and ignores its synthetic exit code', async () => {
		const registry = new BackgroundJobRegistry()
		const process = child()
		const notices: string[] = []
		registry.onExit((job) => notices.push(job.id))

		const job = startWith(registry, process)
		let waitSettled = false
		const waiting = registry.waitForExit(job.id).then(() => {
			waitSettled = true
		})
		process.emit('error', new Error('spawn ENOENT'))
		await Promise.resolve()
		expect(waitSettled).toBe(false)
		expect(registry.get(job.id).status).toBe('running')
		expect(notices).toEqual([])

		process.emit('close', -2, null)
		await waiting
		expect(registry.get(job.id)).toMatchObject({ status: 'exited' })
		expect(registry.get(job.id).exitCode).toBeUndefined()
		expect(notices).toEqual([job.id])
	})

	it('keeps a spawned process running when a later operation errors', async () => {
		const registry = new BackgroundJobRegistry()
		const process = child()
		const notices: string[] = []
		registry.onExit((job) => notices.push(job.id))

		const job = startWith(registry, process)
		process.emit('spawn')
		process.emit('error', new Error('kill EPERM'))
		expect(registry.get(job.id).status).toBe('running')
		expect(notices).toEqual([])

		process.emit('close', 7, null)
		await registry.waitForExit(job.id)
		expect(registry.get(job.id).exitCode).toBe(7)
		expect(notices).toEqual([job.id])
	})
})
