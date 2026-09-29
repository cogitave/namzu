import type { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import { waitForJobWithBounds } from '../../../tools/builtins/wait-for-job-bounds.js'
import { type BackgroundJob, BackgroundJobRegistry } from '../registry.js'

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

class TrackedRegistry extends BackgroundJobRegistry {
	activeExitListeners = 0

	override onExit(listener: (job: BackgroundJob) => void): () => void {
		this.activeExitListeners += 1
		const unsubscribe = super.onExit(listener)
		return () => {
			this.activeExitListeners -= 1
			unsubscribe()
		}
	}
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

describe('a cancellable job exit wait', () => {
	it('removes each listener after repeated bounded waits on a running job', async () => {
		vi.useFakeTimers()
		try {
			const registry = new TrackedRegistry()
			const process = child()
			const job = startWith(registry, process)

			for (let attempt = 0; attempt < 3; attempt += 1) {
				const waiting = waitForJobWithBounds(registry, job.id, { wallMs: 1_000 })
				expect(registry.activeExitListeners).toBe(1)
				await vi.advanceTimersByTimeAsync(1_000)
				expect((await waiting).kind).toBe('timeout')
				expect(registry.activeExitListeners).toBe(0)
				expect(registry.get(job.id).status).toBe('running')
			}

			process.emit('close', 0, null)
			expect(registry.get(job.id).status).toBe('exited')
		} finally {
			vi.useRealTimers()
		}
	})

	it('preserves the abort reason and keeps an exit that won the race', async () => {
		const registry = new TrackedRegistry()
		const abandonedProcess = child()
		const abandoned = startWith(registry, abandonedProcess)
		const abort = new AbortController()
		const reason = new Error('operator stopped waiting')
		const abandonedWait = registry.waitForExit(abandoned.id, { signal: abort.signal })
		expect(registry.activeExitListeners).toBe(1)
		abort.abort(reason)
		await expect(abandonedWait).rejects.toBe(reason)
		expect(registry.activeExitListeners).toBe(0)
		abandonedProcess.emit('close', 0, null)

		const finishedProcess = child()
		const finished = startWith(registry, finishedProcess)
		const lateAbort = new AbortController()
		const finishedWait = registry.waitForExit(finished.id, { signal: lateAbort.signal })
		expect(registry.activeExitListeners).toBe(1)
		finishedProcess.emit('close', 7, null)
		lateAbort.abort(new Error('too late'))
		await expect(finishedWait).resolves.toMatchObject({ status: 'exited', exitCode: 7 })
		expect(registry.activeExitListeners).toBe(0)
	})
})
