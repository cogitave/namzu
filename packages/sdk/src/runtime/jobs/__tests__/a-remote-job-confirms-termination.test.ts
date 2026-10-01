import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { BackgroundJobRegistry } from '../registry.js'

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}

function fixture(terminate: (signal?: NodeJS.Signals) => Promise<void>) {
	const registry = new BackgroundJobRegistry({ maxJobsPerOwner: 1 })
	const child = Object.assign(new EventEmitter(), { pid: undefined })
	const legacyKill = vi.fn()
	const exited = vi.fn()
	registry.onExit(exited)
	const params = {
		owner: 'owner',
		command: 'guest server',
		workingDirectory: '/guest',
		spawn: () => ({
			child: child as ChildProcess,
			kill: legacyKill,
			terminate,
		}),
	}
	const job = registry.start(params)
	return { registry, child, job, exited, legacyKill, params }
}

describe('a remote job requires confirmed tree termination', () => {
	it('retains running state until proof and wrapper close, and shares concurrent stops', async () => {
		const proof = deferred()
		const started = deferred()
		const terminate = vi.fn(() => {
			started.resolve()
			return proof.promise
		})
		const f = fixture(terminate)
		const first = f.registry.kill(f.job.id)
		const second = f.registry.kill(f.job.id)
		await started.promise
		expect(terminate).toHaveBeenCalledTimes(1)
		expect(f.legacyKill).not.toHaveBeenCalled()
		expect(f.registry.get(f.job.id).status).toBe('running')
		expect(f.exited).not.toHaveBeenCalled()
		f.child.emit('close', null, 'SIGTERM')
		expect(f.registry.get(f.job.id).status).toBe('running')
		proof.resolve()
		await expect(first).resolves.toMatchObject({
			status: 'killed',
			signal: 'SIGTERM',
		})
		await expect(second).resolves.toMatchObject({ status: 'killed' })
		expect(f.exited).toHaveBeenCalledTimes(1)
	})
	it('rejects a failed stop, retains ownership and capacity, then permits recovery', async () => {
		const failure = new Error('private transport diagnostic')
		const terminate = vi
			.fn()
			.mockRejectedValueOnce(failure)
			.mockImplementationOnce(async () => {
				f.child.emit('close', 1, null)
			})
		const f = fixture(terminate)
		await expect(f.registry.kill(f.job.id)).rejects.toBe(failure)
		expect(f.registry.get(f.job.id)).toMatchObject({
			status: 'running',
			recoveryRequired: true,
		})
		expect(f.registry.get(f.job.id).stopError).not.toContain('private transport')
		expect(f.exited).not.toHaveBeenCalled()
		expect(() => f.registry.forget(f.job.id)).toThrow('still running')
		expect(() => f.registry.start(f.params)).toThrow('already has 1 running')
		await expect(f.registry.killOwner('owner')).resolves.toMatchObject([{ status: 'killed' }])
		expect(f.registry.get(f.job.id).recoveryRequired).toBeUndefined()
		expect(f.registry.get(f.job.id).stopError).toBeUndefined()
		expect(terminate).toHaveBeenCalledTimes(2)
		expect(f.exited).toHaveBeenCalledTimes(1)
	})
	it('never treats an unexpected wrapper close as proof the guest tree ended', async () => {
		const admitted = deferred()
		const proof = deferred()
		const failure = new Error('retirement failed')
		const terminate = vi
			.fn()
			.mockImplementationOnce(() => {
				admitted.resolve()
				return proof.promise
			})
			.mockResolvedValueOnce(undefined)
		const f = fixture(terminate)
		f.child.emit('close', 1, null)
		await admitted.promise
		expect(f.registry.get(f.job.id).status).toBe('running')
		expect(f.exited).not.toHaveBeenCalled()
		const failed = expect(f.registry.killOwner('owner')).rejects.toBe(failure)
		proof.reject(failure)
		await failed
		expect(f.registry.get(f.job.id)).toMatchObject({
			status: 'running',
			recoveryRequired: true,
		})
		await expect(f.registry.kill(f.job.id)).resolves.toMatchObject({
			status: 'killed',
			exitCode: 1,
		})
		expect(f.exited).toHaveBeenCalledTimes(1)
	})
	it('publishes a natural exit after the provider confirms it', async () => {
		const proof = deferred()
		const started = deferred()
		const f = fixture(() => {
			started.resolve()
			return proof.promise
		})
		f.child.emit('close', 7, null)
		await started.promise
		expect(f.registry.get(f.job.id).status).toBe('running')
		proof.resolve()
		await expect(f.registry.waitForExit(f.job.id)).resolves.toMatchObject({
			status: 'exited',
			exitCode: 7,
		})
		expect(f.exited).toHaveBeenCalledTimes(1)
	})
})
